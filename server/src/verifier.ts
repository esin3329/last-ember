// 리플레이 검증 워커 풀.
// 한 판을 재실행하는 데 수백 ms의 CPU가 들기 때문에 메인 스레드에서 돌리면
// 그동안 다른 요청이 전부 멈춘다. 워커 스레드로 넘기고, 대기열에 상한을 둬서
// 검증 요청이 몰려도 메모리와 지연이 무한정 늘지 않게 한다.

import { Worker } from 'node:worker_threads';
import type { RunResult } from '../../shared/sim.ts';

export type VerifyFn = (seed: number, runs: number[]) => Promise<RunResult>;

interface Job {
  id: number;
  seed: number;
  runs: number[];
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  timer: NodeJS.Timeout | undefined;
  retired: boolean;
  terminating: Promise<number> | null;
}

export interface VerifierPoolOptions {
  maxQueue?: number;
  timeoutMs?: number;
  workerFactory?: () => Worker;
}

export class QueueFullError extends Error {}
export class VerifyError extends Error {}
export class VerifyTimeoutError extends VerifyError {}

export class VerifierPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private seq = 0;
  private closed = false;
  private maxQueue: number;
  private timeoutMs: number;
  private workerFactory: () => Worker;

  constructor(size: number, options: VerifierPoolOptions = {}) {
    this.maxQueue = options.maxQueue ?? 64;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.workerFactory = options.workerFactory ?? (() => new Worker(new URL('./verifyWorker.ts', import.meta.url)));
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const slot: Slot = {
      worker: this.workerFactory(),
      job: null,
      timer: undefined,
      retired: false,
      terminating: null,
    };
    slot.worker.on('message', (msg: { id: number; result: RunResult }) => {
      if (slot.retired || !slot.job || slot.job.id !== msg.id) return;
      this.clearTimer(slot);
      const job = slot.job;
      slot.job = null;
      job.resolve(msg.result);
      this.pump();
    });
    slot.worker.on('error', (err) => {
      this.failSlot(slot, new VerifyError(`verify worker error: ${String(err)}`));
    });
    slot.worker.on('exit', (code) => {
      this.failSlot(slot, new VerifyError(`verify worker exited with code ${code}`));
    });
    return slot;
  }

  private clearTimer(slot: Slot): void {
    clearTimeout(slot.timer);
    slot.timer = undefined;
  }

  private failSlot(slot: Slot, error: VerifyError): void {
    if (slot.retired) return;
    slot.retired = true;
    this.clearTimer(slot);
    const job = slot.job;
    slot.job = null;
    job?.reject(error);

    if (this.closed) return;
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    slot.terminating = slot.worker.terminate();
    void slot.terminating.then(
      () => this.replace(slot, index),
      () => this.replace(slot, index),
    );
    this.pump();
  }

  private replace(slot: Slot, index: number): void {
    if (this.closed || this.slots[index] !== slot) return;
    this.slots[index] = this.spawn();
    this.pump();
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.retired || slot.job || this.queue.length === 0) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.timer = setTimeout(() => this.failSlot(slot, new VerifyTimeoutError('verify timed out')), this.timeoutMs);
      try {
        slot.worker.postMessage({ id: job.id, seed: job.seed, runs: job.runs });
      } catch (err) {
        this.failSlot(slot, new VerifyError(`verify worker postMessage failed: ${String(err)}`));
      }
    }
  }

  verify: VerifyFn = (seed, runs) => {
    if (this.closed) return Promise.reject(new VerifyError('verifier pool closed'));
    if (this.queue.length >= this.maxQueue) return Promise.reject(new QueueFullError('verify queue full'));
    return new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ id: ++this.seq, seed, runs, resolve, reject });
      this.pump();
    });
  };

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new VerifyError('verifier pool closed');
    for (const job of this.queue.splice(0)) job.reject(error);
    const terminations = this.slots.map((slot) => {
      slot.retired = true;
      this.clearTimer(slot);
      slot.job?.reject(error);
      slot.job = null;
      slot.terminating ??= slot.worker.terminate();
      return slot.terminating;
    });
    await Promise.all(terminations);
    this.slots = [];
  }
}

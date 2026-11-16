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
}

export class QueueFullError extends Error {}

export class VerifierPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private seq = 0;
  private closed = false;
  private maxQueue: number;

  constructor(size: number, maxQueue = 64) {
    this.maxQueue = maxQueue;
    for (let i = 0; i < size; i++) this.slots.push(this.spawn());
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(new URL('./verifyWorker.ts', import.meta.url)), job: null };
    slot.worker.on('message', (msg: { id: number; result: RunResult }) => {
      const job = slot.job;
      slot.job = null;
      if (job && job.id === msg.id) job.resolve(msg.result);
      this.pump();
    });
    slot.worker.on('error', (err) => {
      // 워커가 죽으면 맡고 있던 작업만 실패시키고 새 워커로 교체한다.
      slot.job?.reject(err instanceof Error ? err : new Error(String(err)));
      slot.job = null;
      if (this.closed) return;
      const i = this.slots.indexOf(slot);
      if (i >= 0) this.slots[i] = this.spawn();
      this.pump();
    });
    return slot;
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.worker.postMessage({ id: job.id, seed: job.seed, runs: job.runs });
    }
  }

  verify: VerifyFn = (seed, runs) => {
    if (this.queue.length >= this.maxQueue) return Promise.reject(new QueueFullError('verify queue full'));
    return new Promise<RunResult>((resolve, reject) => {
      this.queue.push({ id: ++this.seq, seed, runs, resolve, reject });
      this.pump();
    });
  };

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }
}

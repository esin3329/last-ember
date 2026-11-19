import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { simulate } from '../../shared/replay.ts';
import { QueueFullError, VerifyError, VerifyTimeoutError, VerifierPool } from '../src/verifier.ts';

const workerUrl = new URL('./verifierWorkerFixture.ts', import.meta.url);
const runs = [4, 1];
const seed = 123;
const result = simulate(seed, runs);

interface PostedJob {
  id: number;
  seed: number;
  runs: number[];
}

// 실제 스레드의 스케줄링에 의존하지 않고 메시지·종료·타이머 순서를 제어한다.
class ControlledWorker extends EventEmitter {
  readonly worker = this as unknown as Worker;
  readonly posted: PostedJob[] = [];
  terminationCalls = 0;
  postError: Error | null = null;
  terminateError: Error | null = null;
  private resolveTermination!: (code: number) => void;
  rejectTermination!: (error: Error) => void;
  private termination = new Promise<number>((resolve, reject) => {
    this.resolveTermination = resolve;
    this.rejectTermination = reject;
  });

  postMessage(job: PostedJob): void {
    if (this.postError) throw this.postError;
    this.posted.push(job);
  }

  terminate(): Promise<number> {
    this.terminationCalls++;
    if (this.terminateError) throw this.terminateError;
    return this.termination;
  }

  finishTermination(code = 1): void {
    this.emit('exit', code);
    this.resolveTermination(code);
  }
}

function createWorker(mode: string): Worker {
  return new Worker(workerUrl, { workerData: mode });
}

test('워커 풀 크기가 1~32 범위의 정수가 아니면 워커를 만들지 않고 실패한다', () => {
  let created = 0;
  for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 33]) {
    assert.throws(
      () => new VerifierPool(size, { workerFactory: () => { created++; throw new Error('unexpected worker'); } }),
      /VERIFY_WORKERS must be an integer between 1 and 32/,
    );
  }
  assert.equal(created, 0);
});

test('오류 없이 종료한 워커의 작업은 거부되고 워커를 교체한다', async () => {
  let created = 0;
  const pool = new VerifierPool(1, {
    workerFactory: () => createWorker(created++ === 0 ? 'exit' : 'normal'),
  });
  try {
    await assert.rejects(pool.verify(seed, runs), VerifyError);
    assert.deepEqual(await pool.verify(seed, runs), simulate(seed, runs));
    assert.equal(created, 2);
  } finally {
    await pool.close();
  }
});

test('워커 error와 exit가 연속 발생해도 한 번만 교체한다', async () => {
  let created = 0;
  const pool = new VerifierPool(1, {
    workerFactory: () => createWorker(created++ === 0 ? 'error' : 'normal'),
  });
  try {
    await assert.rejects(pool.verify(seed, runs), VerifyError);
    assert.deepEqual(await pool.verify(seed, runs), simulate(seed, runs));
    assert.equal(created, 2);
  } finally {
    await pool.close();
  }
});

test('작업 타임아웃 시 워커를 종료·교체하고 작업을 거부한다', async () => {
  let created = 0;
  const pool = new VerifierPool(1, {
    timeoutMs: 1000,
    workerFactory: () => createWorker(created++ === 0 ? 'hang' : 'normal'),
  });
  try {
    await assert.rejects(pool.verify(seed, runs), VerifyTimeoutError);
    assert.deepEqual(await pool.verify(seed, runs), simulate(seed, runs));
    assert.equal(created, 2);
  } finally {
    await pool.close();
  }
});

test('결과 직후 종료하면 완료된 작업은 유지하고 다음 작업만 거부한다', async () => {
  let created = 0;
  const pool = new VerifierPool(1, {
    workerFactory: () => createWorker(created++ === 0 ? 'reply-exit' : 'normal'),
  });
  try {
    const completed = pool.verify(seed, runs);
    const interrupted = assert.rejects(pool.verify(seed, runs), /verify worker exited with code 0/);
    assert.deepEqual(await completed, result);
    await interrupted;
    assert.deepEqual(await pool.verify(seed, runs), result);
    assert.equal(created, 2);
  } finally {
    await pool.close();
  }
});

test('생성 도중 실패하면 이미 만든 워커도 종료한다', async () => {
  const first = new ControlledWorker();
  const failure = new Error('worker creation failed');
  let created = 0;
  assert.throws(() => new VerifierPool(2, {
    workerFactory: () => {
      if (created++ === 0) return first.worker;
      throw failure;
    },
  }), (error) => error === failure);
  assert.equal(first.terminationCalls, 1);
  first.finishTermination();
  await Promise.resolve();
  assert.equal(created, 2);
});

test('교체 생성 실패는 나머지 실행·대기 요청을 거부하고 풀을 닫는다', async () => {
  const failed = new ControlledWorker();
  const healthy = new ControlledWorker();
  let created = 0;
  const pool = new VerifierPool(2, {
    workerFactory: () => {
      if (created++ === 0) return failed.worker;
      if (created === 2) return healthy.worker;
      throw new Error('worker limit reached');
    },
  });
  try {
    const first = assert.rejects(pool.verify(seed, runs), /verify worker error/);
    const second = assert.rejects(pool.verify(seed, runs), {
      constructor: VerifyError,
      message: 'verify worker creation failed: Error: worker limit reached',
    });
    const queued = assert.rejects(pool.verify(seed, runs), /verify worker creation failed/);
    failed.emit('error', new Error('worker crashed'));
    failed.finishTermination();
    await Promise.all([first, second, queued]);
    assert.equal(healthy.posted.length, 1);
    assert.equal(healthy.terminationCalls, 1);
    await assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
    healthy.finishTermination();
    await pool.close();
    assert.equal(created, 3);
  } finally {
    failed.finishTermination();
    healthy.finishTermination();
    await pool.close();
  }
});

test('동시 close는 실행·대기 요청을 거부하고 같은 종료 완료를 기다린다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new ControlledWorker();
  let created = 0;
  const pool = new VerifierPool(1, {
    timeoutMs: 10,
    workerFactory: () => { created++; return worker.worker; },
  });
  try {
    const active = assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
    const queued = assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
    const closing = pool.close();
    assert.strictEqual(pool.close(), closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.all([active, queued]);
    await assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
    assert.equal(closed, false);
    assert.equal(worker.terminationCalls, 1);
    worker.emit('message', { id: worker.posted[0].id, result });
    worker.emit('error', new Error('late error'));
    t.mock.timers.tick(10);
    assert.equal(created, 1);
    worker.finishTermination();
    await closing;
    assert.equal(closed, true);
    assert.strictEqual(pool.close(), closing);
  } finally {
    worker.finishTermination();
    await pool.close();
  }
});

test('close는 한 워커 종료가 실패해도 나머지 종료를 기다린다', async () => {
  const failed = new ControlledWorker();
  const pending = new ControlledWorker();
  const workers = [failed, pending];
  const failure = new Error('termination failed');
  const pool = new VerifierPool(2, { workerFactory: () => workers.shift()!.worker });
  const closing = pool.close();
  const rejected = assert.rejects(closing, (error) => error === failure);
  let settled = false;
  void closing.then(() => { settled = true; }, () => { settled = true; });
  failed.rejectTermination(failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(pending.terminationCalls, 1);
  pending.finishTermination();
  await rejected;
  assert.equal(settled, true);
  assert.strictEqual(pool.close(), closing);
});

test('동기 terminate 실패도 다른 워커와 요청의 정리를 막지 않는다', async () => {
  const failed = new ControlledWorker();
  const healthy = new ControlledWorker();
  const workers = [failed, healthy];
  const failure = new Error('synchronous termination failure');
  failed.terminateError = failure;
  const pool = new VerifierPool(2, { workerFactory: () => workers.shift()!.worker });
  const active = assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
  const other = assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
  const queued = assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
  const closing = assert.rejects(pool.close(), (error) => error === failure);
  assert.equal(healthy.terminationCalls, 1);
  healthy.finishTermination();
  await Promise.all([active, other, queued, closing]);
  await assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
});

test('타임아웃 후 늦은 이벤트를 무시하고 종료가 끝나야 대기 작업을 넘긴다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failed = new ControlledWorker();
  const replacement = new ControlledWorker();
  let created = 0;
  const pool = new VerifierPool(1, {
    timeoutMs: 10,
    workerFactory: () => created++ === 0 ? failed.worker : replacement.worker,
  });
  try {
    const timedOut = assert.rejects(pool.verify(seed, runs), VerifyTimeoutError);
    const queued = pool.verify(seed, runs);
    t.mock.timers.tick(10);
    await timedOut;
    failed.emit('message', { id: failed.posted[0].id, result });
    failed.emit('error', new Error('late error'));
    failed.emit('exit', 1);
    assert.equal(failed.terminationCalls, 1);
    assert.equal(created, 1);
    assert.equal(replacement.posted.length, 0);
    failed.finishTermination();
    await Promise.resolve();
    assert.equal(created, 2);
    assert.equal(replacement.posted.length, 1);
    failed.emit('message', { id: replacement.posted[0].id, result: null });
    replacement.emit('message', { id: replacement.posted[0].id, result });
    assert.deepEqual(await queued, result);
  } finally {
    failed.finishTermination();
    replacement.finishTermination();
    await pool.close();
  }
});

test('완료 시 타이머를 취소하고 중복·다른 ID 메시지는 다음 작업에 영향을 주지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new ControlledWorker();
  let created = 0;
  const pool = new VerifierPool(1, {
    timeoutMs: 10,
    workerFactory: () => { created++; return worker.worker; },
  });
  try {
    const completed = pool.verify(seed, runs);
    const next = assert.rejects(pool.verify(seed, runs), VerifyTimeoutError);
    t.mock.timers.tick(9);
    const firstId = worker.posted[0].id;
    worker.emit('message', { id: firstId, result });
    assert.deepEqual(await completed, result);
    t.mock.timers.tick(1);
    assert.equal(worker.terminationCalls, 0);
    worker.emit('message', { id: firstId, result: null });
    worker.emit('message', { id: -1, result: null });
    t.mock.timers.tick(9);
    await next;
    assert.equal(worker.terminationCalls, 1);
    const closing = pool.close();
    worker.finishTermination();
    await closing;
    assert.equal(created, 1);
  } finally {
    worker.finishTermination();
    await pool.close();
  }
});

test('동기 postMessage 실패도 작업을 거부하고 대기 작업을 교체 워커에 넘긴다', async () => {
  const failed = new ControlledWorker();
  const replacement = new ControlledWorker();
  failed.postError = new Error('cannot serialize job');
  let created = 0;
  const pool = new VerifierPool(1, {
    workerFactory: () => created++ === 0 ? failed.worker : replacement.worker,
  });
  try {
    const rejected = assert.rejects(pool.verify(seed, runs), {
      constructor: VerifyError,
      message: 'verify worker postMessage failed: Error: cannot serialize job',
    });
    const queued = pool.verify(seed, runs);
    await rejected;
    assert.equal(failed.terminationCalls, 1);
    assert.equal(created, 1);
    failed.finishTermination();
    await Promise.resolve();
    replacement.emit('message', { id: replacement.posted[0].id, result });
    assert.deepEqual(await queued, result);
    assert.equal(created, 2);
  } finally {
    failed.finishTermination();
    replacement.finishTermination();
    await pool.close();
  }
});

test('유휴 워커 종료 후에도 대기열 상한을 지키고 close 중에는 교체하지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = new ControlledWorker();
  let created = 0;
  const pool = new VerifierPool(1, {
    maxQueue: 1,
    timeoutMs: 10,
    workerFactory: () => { created++; return worker.worker; },
  });
  try {
    worker.emit('exit', 0);
    const queued = assert.rejects(pool.verify(seed, runs), /verifier pool closed/);
    await assert.rejects(pool.verify(seed, runs), QueueFullError);
    assert.equal(worker.posted.length, 0);
    const closing = pool.close();
    await queued;
    t.mock.timers.tick(10);
    assert.equal(worker.terminationCalls, 1);
    worker.finishTermination();
    await closing;
    assert.equal(created, 1);
  } finally {
    worker.finishTermination();
    await pool.close();
  }
});

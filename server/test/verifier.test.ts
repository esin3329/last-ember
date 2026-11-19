import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { test } from 'node:test';
import { simulate } from '../../shared/replay.ts';
import { VerifyError, VerifyTimeoutError, VerifierPool } from '../src/verifier.ts';

const workerUrl = new URL('./verifierWorkerFixture.ts', import.meta.url);
const runs = [4, 1];
const seed = 123;

function createWorker(mode: string): Worker {
  return new Worker(workerUrl, { workerData: mode });
}

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

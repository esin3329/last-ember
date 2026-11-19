import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { SIM_VERSION } from '../../shared/defs.ts';
import { playBot } from '../../shared/test/helpers.ts';
import { createApp } from '../src/app.ts';
import { Store } from '../src/store.ts';
import { VerifyError } from '../src/verifier.ts';

test('검증 장애 직후 경쟁 재제출도 한 요청만 선점하고 한 기록만 남긴다', async () => {
  const store = new Store(':memory:');
  const id = '00000000-0000-4000-8000-000000000001';
  const { runs: inputs, result } = playBot(123);
  assert.equal(result.finished, true);
  store.issueRun(id, 123, SIM_VERSION, '127.0.0.1', 0, 3);
  let calls = 0;
  let complete!: () => void;
  let entered!: () => void;
  const retryEntered = new Promise<void>((resolve) => { entered = resolve; });
  const server = createApp({
    store,
    now: () => 600_000,
    verify: async () => {
      if (++calls === 1) throw new VerifyError('temporary failure');
      entered();
      await new Promise<void>((resolve) => { complete = resolve; });
      return result;
    },
  });
  try {
    server.listen(0);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const submit = () => fetch(`${base}/api/runs/${id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ inputs, score: result.score, checksum: result.checksum, name: '경쟁' }),
    });
    const failed = await submit();
    assert.equal(failed.status, 503);
    assert.equal(store.getRun(id)?.status, 'issued');
    const winner = submit();
    await retryEntered;
    const loser = await submit();
    assert.equal(loser.status, 409);
    assert.deepEqual(await loser.json(), { error: 'already_submitted' });
    complete();
    assert.equal((await winner).status, 200);
    assert.equal(calls, 2);
    assert.equal(store.getRun(id)?.status, 'verified');
    assert.deepEqual(store.leaderboard(SIM_VERSION, 10).map((row) => row.id), [id]);
  } finally {
    complete?.();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { SIM_VERSION } from '../../shared/defs.ts';
import { createApp } from '../src/app.ts';
import { RANKED_LIMITS } from '../src/ranked.ts';
import { Store } from '../src/store.ts';
import { VerifyError } from '../src/verifier.ts';
import { Browser, playRanked } from './rankedClient.ts';

test('검증 장애 직후 경쟁 재제출도 한 요청만 선점하고 한 기록만 남긴다', async () => {
  const store = new Store(':memory:');
  let clock = 0;
  let calls = 0;
  let complete!: () => void;
  let entered!: () => void;
  const retryEntered = new Promise<void>((resolve) => { entered = resolve; });
  let finalResult!: { score: number; kills: number; ticks: number; level: number; won: boolean; finished: boolean; checksum: number };
  const server = createApp({
    store,
    now: () => clock,
    limits: RANKED_LIMITS,
    verify: async () => {
      if (++calls === 1) throw new VerifyError('temporary failure');
      entered();
      await new Promise<void>((resolve) => { complete = resolve; });
      return finalResult;
    },
  });
  try {
    server.listen(0);
    await once(server, 'listening');
    const browser = new Browser(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const played = await playRanked(browser, { advance: (ms) => { clock += ms; } });
    finalResult = { ...played.result, finished: true };
    const body = { score: played.result.score, checksum: played.result.checksum, name: '경쟁' };
    const submit = () => browser.api('POST', `/api/runs/${played.runId}/submit`, body);

    const failed = await submit();
    assert.equal(failed.status, 503);
    assert.equal(store.getRun(played.runId)?.status, 'sealed');
    const winner = submit();
    await retryEntered;
    const loser = await submit();
    assert.equal(loser.status, 409);
    assert.deepEqual(loser.json, { error: 'already_submitted' });
    complete();
    assert.equal((await winner).status, 200);
    assert.equal(calls, 2);
    assert.equal(store.getRun(played.runId)?.status, 'verified');
    assert.deepEqual(store.leaderboard(SIM_VERSION, 10).map((row) => row.id), [played.runId]);
  } finally {
    complete?.();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    store.close();
  }
});

// API 통합 테스트: 메모리 DB + 가짜 시계 + 실제 워커 풀로 서버를 띄워 HTTP로 호출한다.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { playBot } from '../../shared/test/helpers.ts';
import { cleanName, createApp } from '../src/app.ts';
import { RateLimiter } from '../src/rateLimit.ts';
import { Store } from '../src/store.ts';
import { VerifyTimeoutError, VerifierPool } from '../src/verifier.ts';

let base = '';
let clock = 1_000_000;
const store = new Store(':memory:');
const pool = new VerifierPool(2);
const server = createApp({ store, verify: pool.verify, now: () => clock });

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.close();
  store.close();
});

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

/** 시드를 발급받아 봇으로 플레이한 뒤, 플레이에 걸렸을 만큼 시계를 돌린다. */
async function playRun(maxSeconds = 600) {
  const issued = await api('POST', '/api/runs');
  assert.equal(issued.status, 201);
  const { runs, result } = playBot(issued.json.seed, maxSeconds * 60);
  clock += (result.ticks / 60) * 1000 + 1000;
  return { runId: issued.json.runId as string, runs, result };
}

test('정상 플레이는 검증을 통과하고 리더보드에 오른다', async () => {
  const { runId, runs, result } = await playRun();
  assert.ok(result.finished);
  const res = await api('POST', `/api/runs/${runId}/submit`, {
    name: '  테스터\u0007  ',
    inputs: runs,
    score: result.score,
    checksum: result.checksum,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.score, result.score);
  assert.equal(res.json.name, '테스터');
  assert.equal(res.json.rank, 1);

  const board = await api('GET', '/api/leaderboard');
  assert.equal(board.json.entries[0].runId, runId);
  assert.equal(board.json.entries[0].score, result.score);

  // 저장된 리플레이로 다시 돌려도 같은 점수가 나와야 한다.
  const replay = await api('GET', `/api/runs/${runId}/replay`);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json.inputs, runs);
});

test('점수를 부풀려 제출하면 거부된다', async () => {
  const { runId, runs, result } = await playRun();
  const res = await api('POST', `/api/runs/${runId}/submit`, {
    name: 'cheater',
    inputs: runs,
    score: result.score + 100000,
    checksum: result.checksum,
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'mismatch');
  const board = await api('GET', '/api/leaderboard');
  assert.ok(!board.json.entries.some((e: any) => e.runId === runId));
});

test('같은 판은 두 번 제출할 수 없다', async () => {
  const { runId, runs, result } = await playRun();
  const body = { name: 'a', inputs: runs, score: result.score, checksum: result.checksum };
  const [a, b] = await Promise.all([
    api('POST', `/api/runs/${runId}/submit`, body),
    api('POST', `/api/runs/${runId}/submit`, body),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

test('플레이 시간보다 빨리 제출하면 거부된다 (배속/오프라인 계산)', async () => {
  const issued = await api('POST', '/api/runs');
  const { runs, result } = playBot(issued.json.seed);
  clock += 3000; // 수 분짜리 판을 3초 만에 제출
  const res = await api('POST', `/api/runs/${issued.json.runId}/submit`, {
    name: 'fast',
    inputs: runs,
    score: result.score,
    checksum: result.checksum,
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'too_fast');
});

test('발급 후 20분이 지나면 판 제출을 거부한다', async () => {
  const issued = await api('POST', '/api/runs');
  const { runs, result } = playBot(issued.json.seed);
  clock += 20 * 60 * 1000 + 1;
  const res = await api('POST', `/api/runs/${issued.json.runId}/submit`, {
    name: 'expired',
    inputs: runs,
    score: result.score,
    checksum: result.checksum,
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'expired');
  assert.equal(store.getRun(issued.json.runId)?.status, 'rejected');
});

test('IP당 열린 판은 3개로 제한하고 가장 오래된 판을 무효화한다', async () => {
  const first = await api('POST', '/api/runs');
  const { runs, result } = playBot(first.json.seed);
  const issued = [first];
  for (let i = 0; i < 3; i++) issued.push(await api('POST', '/api/runs'));

  assert.equal(first.status, 201);
  assert.equal(store.getRun(first.json.runId)?.status, 'rejected');
  for (const run of issued.slice(1)) {
    assert.equal(run.status, 201);
    assert.equal(store.getRun(run.json.runId)?.status, 'issued');
  }

  const res = await api('POST', `/api/runs/${first.json.runId}/submit`, {
    name: 'abandoned',
    inputs: runs,
    score: result.score,
    checksum: result.checksum,
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'already_submitted');
});

test('검증 타임아웃은 verify_error와 503으로 반환되고 판을 거부한다', async () => {
  const failureStore = new Store(':memory:');
  const failureServer = createApp({
    store: failureStore,
    verify: async () => {
      throw new VerifyTimeoutError('test timeout');
    },
    now: () => clock,
  });
  try {
    await new Promise<void>((resolve) => failureServer.listen(0, resolve));
    const failureBase = `http://127.0.0.1:${(failureServer.address() as AddressInfo).port}`;
    const issueResponse = await fetch(`${failureBase}/api/runs`, { method: 'POST' });
    const issued = (await issueResponse.json()) as { runId: string };
    assert.equal(issueResponse.status, 201);

    const response = await fetch(`${failureBase}/api/runs/${issued.runId}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [4, 1], score: 0, checksum: 0 }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { error: string }).error, 'verify_error');
    assert.equal(failureStore.getRun(issued.runId)?.status, 'rejected');
    assert.equal(failureStore.getRun(issued.runId)?.reject_reason, 'verify_error');
  } finally {
    await new Promise<void>((resolve, reject) => failureServer.close((err) => err ? reject(err) : resolve()));
    failureStore.close();
  }
});

test('끝나지 않은 판은 기록되지 않는다', async () => {
  const { runId, runs, result } = await playRun(5);
  assert.ok(!result.finished);
  const res = await api('POST', `/api/runs/${runId}/submit`, {
    name: 'quit',
    inputs: runs,
    score: result.score,
    checksum: result.checksum,
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'unfinished');
});

test('형식이 잘못된 요청은 400/404', async () => {
  const issued = await api('POST', '/api/runs');
  const id = issued.json.runId;
  assert.equal((await api('POST', `/api/runs/${id}/submit`, { inputs: [15, 1], score: 1, checksum: 1 })).status, 400);
  assert.equal((await api('POST', `/api/runs/${id}/submit`, { inputs: 'x', score: 1, checksum: 1 })).status, 400);
  assert.equal((await api('POST', `/api/runs/not-a-uuid/submit`, { inputs: [4, 1], score: 1, checksum: 1 })).status, 404);
  assert.equal((await api('GET', `/api/runs/${id}/replay`)).status, 404); // 검증 전에는 비공개
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await api('POST', `/api/runs/${unknown}/submit`, { inputs: [4, 1], score: 1, checksum: 1 })).status, 404);
});

test('토큰 버킷 속도 제한', () => {
  const rl = new RateLimiter(3, 60);
  assert.deepEqual([rl.take('a', 0), rl.take('a', 0), rl.take('a', 0), rl.take('a', 0)], [true, true, true, false]);
  assert.equal(rl.take('b', 0), true); // 다른 키는 독립
  assert.equal(rl.take('a', 1000), true); // 1초 뒤 1개 충전
  assert.equal(rl.take('a', 1000), false);
});

test('이름 정리', () => {
  assert.equal(cleanName('  a\tb  '), 'a b');
  assert.equal(cleanName('<script>alert(1)</script>'), '<script>aler');
  assert.equal(cleanName(''), '익명');
  assert.equal(cleanName(42), '익명');
  assert.equal(cleanName('가나다라마바사아자차카타파하'), '가나다라마바사아자차카타');
});

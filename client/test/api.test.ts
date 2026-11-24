// 최종 제출 흐름(마지막 구간 확정 + 제출)의 재시도 규칙. fetch를 가짜로 바꿔 서버 응답 유실·검증 중 상황을 재현한다.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { submitRun, type FinalSubmitState } from '../src/api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Reply = [status: number, body: unknown] | 'network';

/** 요청마다 순서대로 정해 둔 응답을 돌려준다. 요청 경로를 기록한다. */
function fakeServer(replies: Reply[]): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = replies.shift();
    if (!next) throw new Error(`예상하지 못한 요청: ${String(input)}`);
    if (next === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(next[1]), { status: next[0], headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const final = { index: 7, runs: [4, 20] };
const payload = { name: '나', score: 100, checksum: 5 };
const ok = { ok: true, name: '나', score: 100, rank: 2 };
const ack = { ok: true, index: 7, final: true, next: null };

test('최종 구간 ACK를 받은 뒤의 재시도는 구간을 다시 보내지 않는다', async () => {
  const state: FinalSubmitState = { finalCommitted: false };
  const calls = fakeServer([[200, ack], 'network', [200, ok]]);
  assert.deepEqual(await submitRun('run', final, payload, state), { ok: false, error: 'network' });
  assert.equal(state.finalCommitted, true);
  assert.deepEqual(await submitRun('run', final, payload, state), ok);
  assert.deepEqual(calls, ['/api/runs/run/segments/7', '/api/runs/run/submit', '/api/runs/run/submit']);
});

test('ACK가 유실돼 구간을 다시 보냈는데 이미 검증된 판이면 제출로 넘어가 같은 성공 응답을 받는다', async () => {
  const state: FinalSubmitState = { finalCommitted: false };
  const calls = fakeServer([[409, { error: 'already_submitted' }], [200, ok]]);
  assert.deepEqual(await submitRun('run', final, payload, state), ok);
  assert.deepEqual(calls, ['/api/runs/run/segments/7', '/api/runs/run/submit']);
});

test('다른 요청이 검증 중이면 잠시 뒤 같은 제출을 다시 보내 결과를 회수한다', async () => {
  const calls = fakeServer([[200, ack], [409, { error: 'already_submitted' }], [200, ok]]);
  assert.deepEqual(await submitRun('run', final, payload), ok);
  assert.equal(calls.filter((c) => c.endsWith('/submit')).length, 2);
});

test('구간 확정이 만료·무효화로 거절되면 제출하지 않고 그대로 돌려준다', async () => {
  const state: FinalSubmitState = { finalCommitted: false };
  const calls = fakeServer([[422, { error: 'timeout' }]]);
  assert.deepEqual(await submitRun('run', final, payload, state), { ok: false, error: 'timeout' });
  assert.equal(state.finalCommitted, false);
  assert.deepEqual(calls, ['/api/runs/run/segments/7']);
});

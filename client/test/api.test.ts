// 전체 입력을 포함한 최종 제출의 응답 유실·검증 중 재시도 시나리오.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { submitRun } from '../src/api.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Reply = [status: number, body: unknown] | 'network';

/** 요청 순서와 본문을 기록하며 미리 정한 응답을 반환한다. */
function fakeServer(replies: Reply[]): { path: string; body: unknown }[] {
  const calls: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
    const next = replies.shift();
    if (!next) throw new Error(`예상하지 못한 요청: ${String(input)}`);
    if (next === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(next[1]), { status: next[0], headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const payload = { name: '나', score: 100, checksum: 5, inputs: [4, 20] };
const ok = { ok: true, name: '나', score: 100, rank: 2 };

test('응답 유실 후에도 같은 전체 입력을 최종 제출로 다시 보낸다', async () => {
  const calls = fakeServer(['network', [200, ok]]);
  assert.deepEqual(await submitRun('run', payload), { ok: false, error: 'network' });
  assert.deepEqual(await submitRun('run', payload), ok);
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ path: '/api/runs/run/submit', body: payload })));
});

test('검증 중이면 같은 본문으로 결과를 다시 요청한다', async () => {
  const calls = fakeServer([[409, { error: 'already_submitted' }], [200, ok]]);
  assert.deepEqual(await submitRun('run', payload), ok);
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({ path: '/api/runs/run/submit', body: payload })));
});

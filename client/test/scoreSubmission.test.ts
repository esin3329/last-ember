import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { ScoreSubmission } from '../src/scoreSubmission.ts';

test('일시 장애 후 같은 제출만 재시도하며 전송 중 중복 클릭은 무시한다', async () => {
  const states: unknown[] = [];
  const submission = new ScoreSubmission((status) => states.push(status));
  let sends = 0;
  submission.start(async () => ++sends === 1 ? { ok: false, error: 'server_busy' } : { ok: true, rank: 7 });
  submission.retry();
  await setImmediate();
  submission.retry();
  submission.retry();
  await setImmediate();
  submission.retry();
  assert.equal(sends, 2);
  assert.deepEqual(states, [
    { state: 'pending', retry: false },
    { state: 'failed', error: 'server_busy', retry: true },
    { state: 'pending', retry: true },
    { state: 'submitted', rank: 7 },
  ]);
});

test('이전 판의 늦은 응답을 버리고 새 판의 확정 거절은 재시도하지 않는다', async () => {
  const states: unknown[] = [];
  const submission = new ScoreSubmission((status) => states.push(status));
  const old = new EventEmitter();
  submission.start(async () => {
    await once(old, 'complete');
    return { ok: true, rank: 3 };
  });
  submission.discard();
  let sends = 0;
  submission.start(async () => {
    sends++;
    return { ok: false, error: 'expired' };
  });
  old.emit('complete');
  await setImmediate();
  submission.retry();
  assert.equal(sends, 1);
  assert.deepEqual(states, [
    { state: 'pending', retry: false },
    { state: 'pending', retry: false },
    { state: 'failed', error: 'expired', retry: false },
  ]);
});

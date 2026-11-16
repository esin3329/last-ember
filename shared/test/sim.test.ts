import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_TICKS } from '../defs.ts';
import { InputRecorder, type InputFrame, countTicks, decodeFrame, encodeFrame, expandRuns } from '../input.ts';
import { playBot } from './helpers.ts';
import { simulate } from '../replay.ts';
import { makeRng, nextU32 } from '../rng.ts';
import { createSim, resultOf, step } from '../sim.ts';

test('RNG는 같은 시드에서 같은 수열을 낸다', () => {
  const a = makeRng(1234);
  const b = makeRng(1234);
  for (let i = 0; i < 1000; i++) assert.equal(nextU32(a), nextU32(b));
  // 다른 구현으로 포팅할 때 기준이 되는 고정값
  const c = makeRng(1);
  assert.deepEqual([nextU32(c), nextU32(c), nextU32(c)], [2693262067, 11749833, 2265367787]);
});

test('입력 프레임 인코딩은 모든 조합에서 왕복된다', () => {
  const out: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  for (const mx of [-1, 0, 1]) for (const my of [-1, 0, 1]) for (const dash of [false, true]) for (const choice of [-1, 0, 1, 2]) {
    const code = encodeFrame({ mx, my, dash, choice });
    assert.ok(code >= 0 && code < 128);
    assert.deepEqual(decodeFrame(code, out), { mx, my, dash, choice });
  }
});

test('RLE 기록과 복원', () => {
  const rec = new InputRecorder();
  const codes = [4, 4, 4, 5, 5, 4, 20, 20, 20, 20];
  for (const c of codes) rec.push(c);
  assert.deepEqual(rec.runs, [4, 3, 5, 2, 4, 1, 20, 4]);
  assert.deepEqual([...expandRuns(rec.runs)], codes);
  assert.equal(countTicks(rec.runs, 100), 10);
});

test('잘못된 입력 로그는 거부된다', () => {
  assert.equal(countTicks([4, 3, 5], 100), -1); // 홀수 길이
  assert.equal(countTicks([15, 1], 100), -1); // 존재하지 않는 이동 코드
  assert.equal(countTicks([4, 0], 100), -1); // 0회 반복
  assert.equal(countTicks([4, 1.5], 100), -1);
  assert.equal(countTicks([4, 101], 100), -1); // 상한 초과
  assert.equal(countTicks('nope', 100), -1);
});

test('같은 시드 + 같은 입력이면 결과가 완전히 같다 (결정론)', () => {
  const { runs, result } = playBot(20260101, 60 * 90);
  const again = simulate(20260101, runs);
  assert.deepEqual(again, result);
  // 이벤트를 내보내는 모드(클라이언트)와 내보내지 않는 모드(서버)도 같아야 한다.
  const s = createSim(20260101, true);
  const f: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  for (const code of expandRuns(runs)) step(s, decodeFrame(code, f));
  assert.deepEqual(resultOf(s), result);
});

test('시드가 다르면 전개가 달라진다', () => {
  const { runs, result } = playBot(111, 60 * 60);
  const other = simulate(222, runs);
  assert.notEqual(other.checksum, result.checksum);
});

test('입력이 한 틱만 달라도 체크섬이 달라진다', () => {
  const { runs, result } = playBot(333, 60 * 60);
  const tampered = runs.slice();
  tampered[0] = tampered[0] === 4 ? 5 : 4;
  assert.notEqual(simulate(333, tampered).checksum, result.checksum);
});

test('한 판은 반드시 끝난다 (사망 또는 승리)', () => {
  const { result } = playBot(98765);
  assert.ok(result.finished);
  assert.ok(result.ticks <= MAX_TICKS);
  assert.ok(result.score > 0);
});

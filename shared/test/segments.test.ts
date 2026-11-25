// v3 구간 시드: 구간 경계는 입력 프레임 수로 정해지고, 리플레이는 공개된 구간 시드로만 재현된다.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEGMENT_FRAMES, rulesFor } from '../defs.ts';
import { simulate } from '../replay.ts';
import { beginSegment, createSim, segmentDue, step } from '../sim.ts';
import { BotRun, playBot } from './helpers.ts';

const seedFor = (index: number): number => (Math.imul(index + 1, 0x9e3779b1) ^ 0x5bd1e995) | 0;
const framesOf = (runs: number[]): number => runs.reduce((n, v, i) => (i % 2 === 1 ? n + v : n), 0);

test('rulesFor: 버전별 구간 길이와 종료 제출 규칙을 구분한다', () => {
  assert.deepEqual(rulesFor(2), { segmentFrames: 0 });
  assert.deepEqual(rulesFor(3), { segmentFrames: 60 });
  assert.equal(rulesFor(1), null);
  assert.deepEqual(rulesFor(4), { segmentFrames: 180 });
  assert.deepEqual(rulesFor(5), { segmentFrames: 0 });
  assert.equal(rulesFor(6), null);
});

test('구간 경계는 틱이 아니라 입력 프레임 기준이다(레벨업 선택 프레임은 틱을 올리지 않는다)', () => {
  const { runs, segmentSeeds, result } = playBot(112, undefined, seedFor);
  const frames = framesOf(runs);
  assert.ok(result.finished);
  // 레벨업 선택 프레임 때문에 프레임 수가 틱 수보다 크다.
  assert.ok(frames > result.ticks, `frames ${frames} ticks ${result.ticks}`);
  // 시드는 정확히 입력 프레임 한 구간을 쓸 때마다 한 번 필요했다.
  assert.equal(segmentSeeds.length, Math.floor((frames - 1) / SEGMENT_FRAMES));
  // 경계 시점마다 프레임은 정확히 구간 길이의 배수이고, 틱은 그보다 작다(선택 프레임 수만큼).
  const bot = new BotRun(112);
  let sawGap = false;
  for (let i = 1; ; i++) {
    const seg = bot.playSegment();
    if (seg.final) break;
    assert.equal(bot.sim.frame, i * SEGMENT_FRAMES);
    assert.ok(bot.sim.tick <= bot.sim.frame);
    sawGap ||= bot.sim.tick < bot.sim.frame;
    bot.nextSegment(seedFor(i));
  }
  assert.ok(sawGap);
});

test('공개된 구간 시드로 입력 기록을 다시 돌리면 같은 결과가 나온다', () => {
  const { runs, segmentSeeds, result } = playBot(20260101, undefined, seedFor);
  assert.ok(segmentSeeds.length > 3);
  const rules = { segmentFrames: SEGMENT_FRAMES, segmentSeeds };
  assert.deepEqual(simulate(20260101, runs, rules), result);

  // 구간 시드가 다르면 같은 입력도 다른 판이 된다.
  const other = simulate(20260101, runs, { ...rules, segmentSeeds: segmentSeeds.map((v) => v ^ 1) });
  assert.notEqual(other.checksum, result.checksum);
});

test('필요한 구간 시드가 모자라면 미완료로 멈춘다', () => {
  const { runs, segmentSeeds } = playBot(20260101, undefined, seedFor);
  const short = simulate(20260101, runs, { segmentFrames: SEGMENT_FRAMES, segmentSeeds: segmentSeeds.slice(0, 1) });
  assert.equal(short.finished, false);
  assert.ok(short.ticks <= 2 * SEGMENT_FRAMES);
});

test('v2 규칙(구간 없음)은 시드 하나로 끝까지 진행하고 구간 시드는 필요하지 않다', () => {
  const { runs, segmentSeeds, result } = playBot(7919);
  assert.equal(segmentSeeds.length, 0);
  assert.deepEqual(simulate(7919, runs), result);
  assert.deepEqual(simulate(7919, runs, { segmentFrames: 0, segmentSeeds: [1, 2, 3] }), result);
});

test('구간 시드 없이 경계를 넘는 step()은 예외, 시기가 아닌 beginSegment()도 예외', () => {
  const s = createSim(5, false, 10);
  const frame = { mx: 0, my: 0, dash: false, choice: -1 };
  assert.throws(() => beginSegment(s, 1), /not due/);
  for (let i = 0; i < 10; i++) step(s, frame);
  assert.equal(segmentDue(s), true);
  assert.throws(() => step(s, frame), /segment seed required/);
  beginSegment(s, 99);
  assert.equal(segmentDue(s), false);
  assert.equal(s.segment, 1);
  step(s, frame);
});

test('BotRun이 구간별로 낸 입력을 이어 붙이면 한 번에 플레이한 기록과 같다', () => {
  const whole = playBot(148, undefined, seedFor);
  const bot = new BotRun(148);
  const parts: number[][] = [];
  for (let i = 1; ; i++) {
    const seg = bot.playSegment();
    parts.push(seg.runs);
    if (seg.final) break;
    assert.equal(seg.frames, SEGMENT_FRAMES);
    bot.nextSegment(seedFor(i));
  }
  assert.deepEqual(simulate(148, parts.flat(), { segmentFrames: SEGMENT_FRAMES, segmentSeeds: whole.segmentSeeds }), whole.result);
});

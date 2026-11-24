// 리플레이 재실행. 서버 검증과 클라이언트 리플레이 재생이 함께 쓴다.

import { type InputFrame, decodeFrame } from './input.ts';
import { type RunResult, beginSegment, createSim, resultOf, segmentDue, step } from './sim.ts';

/** 리플레이 한 건의 규칙. v2는 segmentFrames 0, v3는 구간 길이와 공개된 구간 시드(1번 구간부터)를 쓴다. */
export interface ReplayRules {
  segmentFrames: number;
  /** 구간 1, 2, ...의 시드. 0번 구간 시드는 seed 인자다. */
  segmentSeeds: readonly number[];
}

export const LEGACY_RULES: ReplayRules = { segmentFrames: 0, segmentSeeds: [] };

/**
 * 시드와 RLE 입력으로 처음부터 끝까지 시뮬레이션을 돌려 결과를 낸다(연출 이벤트 없음).
 * v3에서 필요한 구간 시드가 모자라면 거기서 멈추고 finished=false 결과를 돌려준다.
 */
export function simulate(seed: number, runs: readonly number[], rules: ReplayRules = LEGACY_RULES): RunResult {
  const s = createSim(seed, false, rules.segmentFrames);
  const frame: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  let nextSeed = 0;
  outer: for (let i = 0; i < runs.length; i += 2) {
    decodeFrame(runs[i], frame);
    for (let c = runs[i + 1]; c > 0; c--) {
      if (segmentDue(s)) {
        if (nextSeed >= rules.segmentSeeds.length) break outer;
        beginSegment(s, rules.segmentSeeds[nextSeed++]);
      }
      step(s, frame);
      if (s.phase === 'dead' || s.phase === 'won') break outer;
    }
  }
  return resultOf(s);
}

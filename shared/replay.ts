// 리플레이 재실행. 서버 검증과 클라이언트 리플레이 재생이 함께 쓴다.

import { type InputFrame, decodeFrame } from './input.ts';
import { type RunResult, createSim, resultOf, step } from './sim.ts';

/** 시드와 RLE 입력으로 처음부터 끝까지 시뮬레이션을 돌려 결과를 낸다(연출 이벤트 없음). */
export function simulate(seed: number, runs: number[]): RunResult {
  const s = createSim(seed, false);
  const frame: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  outer: for (let i = 0; i < runs.length; i += 2) {
    decodeFrame(runs[i], frame);
    for (let c = runs[i + 1]; c > 0; c--) {
      step(s, frame);
      if (s.phase === 'dead' || s.phase === 'won') break outer;
    }
  }
  return resultOf(s);
}

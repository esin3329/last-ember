import { botInput } from '../bot.ts';
import { MAX_TICKS, SEGMENT_FRAMES } from '../defs.ts';
import { InputRecorder, type InputFrame, encodeFrame } from '../input.ts';
import { type SimState, beginSegment, createSim, resultOf, segmentDue, step } from '../sim.ts';

/**
 * 봇이 구간 단위로 플레이한다. 서버와 주고받는 흐름(구간 입력 확정 → 다음 시드)을 그대로 시험할 때 쓴다.
 * segmentFrames가 0이면 v2처럼 구간 없이 한 번에 끝까지 진행한다.
 */
export class BotRun {
  readonly sim: SimState;
  private readonly frame: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };

  constructor(seed: number, segmentFrames = SEGMENT_FRAMES) {
    this.sim = createSim(seed, false, segmentFrames);
  }

  get finished(): boolean {
    return this.sim.phase === 'dead' || this.sim.phase === 'won';
  }

  /** 구간 경계(다음 시드가 필요한 시점)나 판 종료까지 진행하고, 그 구간의 RLE 입력을 돌려준다. */
  playSegment(maxFrames = Infinity): { runs: number[]; frames: number; final: boolean } {
    const rec = new InputRecorder();
    while (!this.finished && !segmentDue(this.sim) && this.sim.tick < MAX_TICKS && rec.total < maxFrames) {
      botInput(this.sim, this.frame);
      rec.push(encodeFrame(this.frame));
      step(this.sim, this.frame);
    }
    return { runs: rec.runs, frames: rec.total, final: this.finished };
  }

  nextSegment(seed: number): void {
    beginSegment(this.sim, seed);
  }
}

/**
 * 봇으로 한 판을 끝까지 플레이하고 입력 로그와 결과를 돌려준다.
 * segmentSeed를 주면 v3 규칙으로 플레이하고, 구간 i(1부터)의 시드를 segmentSeed(i)로 정한다.
 */
export function playBot(seed: number, maxTicks = MAX_TICKS, segmentSeed?: (index: number) => number) {
  const s = createSim(seed, false, segmentSeed ? SEGMENT_FRAMES : 0);
  const rec = new InputRecorder();
  const segmentSeeds: number[] = [];
  const f: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  while (s.phase !== 'dead' && s.phase !== 'won' && s.tick < maxTicks) {
    if (segmentSeed && segmentDue(s)) {
      const next = segmentSeed(s.segment + 1) | 0;
      segmentSeeds.push(next);
      beginSegment(s, next);
    }
    botInput(s, f);
    rec.push(encodeFrame(f));
    step(s, f);
  }
  return { runs: rec.runs, segmentSeeds, result: resultOf(s) };
}

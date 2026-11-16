import { botInput } from '../bot.ts';
import { MAX_TICKS } from '../defs.ts';
import { InputRecorder, type InputFrame, encodeFrame } from '../input.ts';
import { createSim, resultOf, step } from '../sim.ts';

/** 봇으로 한 판을 끝까지 플레이하고 입력 로그와 결과를 돌려준다. */
export function playBot(seed: number, maxTicks = MAX_TICKS) {
  const s = createSim(seed, false);
  const rec = new InputRecorder();
  const f: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };
  while (s.phase !== 'dead' && s.phase !== 'won' && s.tick < maxTicks) {
    botInput(s, f);
    rec.push(encodeFrame(f));
    step(s, f);
  }
  return { runs: rec.runs, result: resultOf(s) };
}

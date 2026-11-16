// 헤드리스 밸런스 측정: 봇으로 여러 판을 돌려 난이도 곡선과 시뮬레이션 비용을 확인한다.
//   npm run balance -- 40

import { botInput } from '../shared/bot.ts';
import { DT, UPGRADE_META } from '../shared/defs.ts';
import type { InputFrame } from '../shared/input.ts';
import { createSim, step } from '../shared/sim.ts';

const runs = Number(process.argv[2] ?? 30);
const frame: InputFrame = { mx: 0, my: 0, dash: false, choice: -1 };

let wins = 0;
let reachedBoss = 0;
let totalTicks = 0;
let totalMs = 0;
let maxEnemies = 0;
const times: number[] = [];
const levels: number[] = [];

for (let seed = 1; seed <= runs; seed++) {
  const s = createSim(seed * 7919, false);
  const t0 = performance.now();
  while (s.phase !== 'dead' && s.phase !== 'won') {
    step(s, botInput(s, frame));
    if (s.enemies.length > maxEnemies) maxEnemies = s.enemies.length;
  }
  totalMs += performance.now() - t0;
  totalTicks += s.tick;
  times.push(s.tick * DT);
  levels.push(s.player.level);
  if (s.bossSpawned) reachedBoss++;
  if (s.phase === 'won') wins++;
  if (seed <= 5) {
    const build = s.levels.map((l, i) => (l ? `${UPGRADE_META[i].name}${l}` : '')).filter(Boolean).join(' ');
    console.log(`seed ${seed}: ${s.phase} ${(s.tick * DT).toFixed(0)}s lv${s.player.level} score ${s.score} kills ${s.kills} | ${build}`);
  }
}

times.sort((a, b) => a - b);
const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`\n${runs}판 | 보스 도달 ${reachedBoss} | 승리 ${wins}`);
console.log(`생존 시간 중앙값 ${times[times.length >> 1].toFixed(0)}s, 평균 ${avg(times).toFixed(0)}s, 평균 레벨 ${avg(levels).toFixed(1)}`);
console.log(`최대 동시 적 ${maxEnemies} | 틱당 ${((totalMs / totalTicks) * 1000).toFixed(1)}µs | 한 판 검증 평균 ${(totalMs / runs).toFixed(1)}ms`);

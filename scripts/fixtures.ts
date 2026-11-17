// C# 포팅 검증용 기준 데이터 생성: 봇으로 여러 판을 돌려 시드·입력·결과를 csharp/fixtures.json에 쓴다.
//   node scripts/fixtures.ts

import { writeFileSync } from 'node:fs';
import { makeRng, nextU32 } from '../shared/rng.ts';
import { playBot } from '../shared/test/helpers.ts';

// 승리/사망, 짧은 판/긴 판이 섞이도록 고른 시드. 112·148은 생명 파동·폭풍 고리 진화가 나오는 판이다.
const seeds = [7919, 15838, 23757, 39595, 20260101, 764885647, 1, 2147483646, 112, 148];

const rng = makeRng(1);
const out = {
  rng: Array.from({ length: 16 }, () => nextU32(rng)),
  runs: seeds.map((seed) => {
    const { runs, result } = playBot(seed);
    return { seed, inputs: runs, result };
  }),
};

writeFileSync(new URL('../csharp/fixtures.json', import.meta.url), JSON.stringify(out));
console.log(out.runs.map((r) => `${r.seed}: ${r.result.won ? 'won' : 'dead'} ${r.result.ticks} ticks`).join('\n'));

// C# 포팅 검증용 기준 데이터 생성: 봇으로 여러 판을 돌려 시드·입력·결과를 csharp/fixtures.json에 쓴다.
//   node scripts/fixtures.ts
//
// 리플레이 형식(TypeScript와 C#이 같은 모양을 읽는다):
//   { version, seed, segmentFrames, segmentSeeds, inputs, result }
//   version 2: segmentFrames 0, segmentSeeds []  (구 랭킹·오프라인 규칙)
//   version 3: segmentFrames SEGMENT_FRAMES, segmentSeeds는 구간 1, 2, ...의 시드(int32)

import { writeFileSync } from 'node:fs';
import { LEGACY_SIM_VERSION, SIM_VERSION, rulesFor } from '../shared/defs.ts';
import { simulate } from '../shared/replay.ts';
import { makeRng, nextU32 } from '../shared/rng.ts';
import { playBot } from '../shared/test/helpers.ts';

// 승리/사망, 짧은 판/긴 판이 섞이도록 고른 시드. 112·148은 생명 파동·폭풍 고리 진화가 나오는 판이다.
const seeds = [7919, 15838, 23757, 39595, 20260101, 764885647, 1, 2147483646, 112, 148];
const v3Seeds = [7919, 20260101, 112, 148, 1, 764885647];

const rng = makeRng(1);

function legacy(seed: number) {
  const { runs, result } = playBot(seed);
  return { version: LEGACY_SIM_VERSION, seed, segmentFrames: 0, segmentSeeds: [] as number[], inputs: runs, result };
}

function ranked(seed: number) {
  const seedRng = makeRng(seed ^ 0x5eed);
  const { runs, segmentSeeds, result } = playBot(seed, undefined, () => nextU32(seedRng) | 0);
  return { version: SIM_VERSION, seed, segmentFrames: rulesFor(SIM_VERSION)!.segmentFrames, segmentSeeds, inputs: runs, result };
}

const runs = [...seeds.map(legacy), ...v3Seeds.map(ranked)];

// 구간 시드가 모자란 v3 리플레이는 필요한 시드 앞에서 멈추고 finished=false를 돌려줘야 한다.
const base = ranked(20260101);
const truncated = { ...base, segmentSeeds: base.segmentSeeds.slice(0, 2) };
truncated.result = simulate(truncated.seed, truncated.inputs, truncated);
runs.push(truncated);

const out = {
  rng: Array.from({ length: 16 }, () => nextU32(rng)),
  runs,
};

writeFileSync(new URL('../csharp/fixtures.json', import.meta.url), JSON.stringify(out));
console.log(
  out.runs
    .map((r) => `v${r.version} ${r.seed}: ${r.result.finished ? (r.result.won ? 'won' : 'dead') : 'unfinished'} ${r.result.ticks} ticks`)
    .join('\n'),
);

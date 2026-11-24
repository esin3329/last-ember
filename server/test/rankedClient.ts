// 랭킹(v3) 테스트용 브라우저 흉내: 세션 쿠키를 보관하고, 봇이 구간 단위로 서버와 주고받으며 한 판을 플레이한다.

import assert from 'node:assert/strict';
import { resultOf } from '../../shared/sim.ts';
import { BotRun } from '../../shared/test/helpers.ts';

export interface Reply {
  status: number;
  json: any;
  headers: Headers;
}

export class Browser {
  cookie = '';
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.cookie ? { Cookie: this.cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie()[0];
    if (set) this.cookie = set.split(';')[0];
    return { status: res.status, json: await res.json(), headers: res.headers };
  }
}

export interface Clock {
  advance(ms: number): void;
}

export interface Played {
  runId: string;
  seed: number;
  bot: BotRun;
  result: ReturnType<typeof resultOf>;
  /** 서버가 공개한 구간 시드(1번 구간부터). */
  segmentSeeds: number[];
}

/**
 * 발급 → 구간 플레이 → 구간 확정을 마지막 구간까지 반복한다. 구간마다 실제 플레이 시간만큼 시계를 돌린다.
 * stopAfter를 주면 그 수만큼 구간을 확정하고 멈춘다(최종 구간을 보내지 않음).
 */
export async function playRanked(browser: Browser, clock: Clock, stopAfter = Infinity): Promise<Played> {
  const issued = await browser.api('POST', '/api/runs');
  assert.equal(issued.status, 201, JSON.stringify(issued.json));
  const runId = issued.json.runId as string;
  const bot = new BotRun(issued.json.seed, issued.json.segmentFrames);
  const segmentSeeds: number[] = [];
  for (let index = 0; ; index++) {
    const seg = bot.playSegment();
    // 가짜 시계는 정수 ms로 유지한다. 소수가 되면 발급 이력 경계(issued_at > now - windowMs)가 부동소수 오차로 1ms 어긋난다.
    clock.advance(Math.ceil((seg.frames / 60) * 1000) + 200);
    const res = await browser.api('POST', `/api/runs/${runId}/segments/${index}`, { inputs: seg.runs, final: seg.final });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    if (seg.final) break;
    assert.equal(res.json.next.index, index + 1);
    segmentSeeds.push(res.json.next.seed);
    if (index + 1 >= stopAfter) break;
    bot.nextSegment(res.json.next.seed);
  }
  return { runId, seed: issued.json.seed, bot, result: resultOf(bot.sim), segmentSeeds };
}

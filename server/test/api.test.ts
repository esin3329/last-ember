// API 통합 테스트: 메모리 DB + 가짜 시계 + 실제 워커 풀로 서버를 띄워 HTTP로 호출한다.
// 클라이언트 역할은 봇이 맡아, 구간 입력 확정과 다음 시드 수신을 실제 프로토콜대로 주고받는다.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SEGMENT_FRAMES, SIM_VERSION } from '../../shared/defs.ts';
import { simulate } from '../../shared/replay.ts';
import { resultOf } from '../../shared/sim.ts';
import { BotRun, playBot } from '../../shared/test/helpers.ts';
import { cleanName, createApp } from '../src/app.ts';
import { RANKED_LIMITS, type RankedLimits } from '../src/ranked.ts';
import { RateLimiter } from '../src/rateLimit.ts';
import { Store } from '../src/store.ts';
import { QueueFullError, VerifyTimeoutError, VerifierPool } from '../src/verifier.ts';
import { Browser, playRanked } from './rankedClient.ts';

// 공유 서버는 IP 보조 상한을 넉넉히 두고(테스트들이 한 IP를 공유한다) 세션 한도는 실제 값을 쓴다.
const sharedLimits: RankedLimits = { ...RANKED_LIMITS, ipWindow: 10_000, ipOpen: 10_000, ipNewSessions: 10_000 };

let base = '';
let clock = 1_000_000;
const clockCtl = { advance: (ms: number) => { clock += ms; } };
const store = new Store(':memory:', sharedLimits);
const db = Reflect.get(store, 'db') as DatabaseSync;
const pool = new VerifierPool(2);
const server = createApp({ store, verify: pool.verify, now: () => clock, limits: sharedLimits });

before(async () => {
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.close();
  store.close();
});

const browser = () => new Browser(base);
const submitBody = (p: { result: { score: number; checksum: number } }, name = 'tester') => ({
  name,
  score: p.result.score,
  checksum: p.result.checksum,
});

test('정상 플레이는 구간별로 확정되고 서버 저장본으로 검증되어 리더보드에 오른다', async () => {
  const b = browser();
  const played = await playRanked(b, clockCtl);
  assert.ok(played.result.finished);
  assert.ok(played.segmentSeeds.length > 3, '여러 구간으로 나뉘어야 한다');
  const res = await b.api('POST', `/api/runs/${played.runId}/submit`, submitBody(played, '  테스터\u0007  '));
  assert.equal(res.status, 200);
  assert.equal(res.json.score, played.result.score);
  assert.equal(res.json.name, '테스터');
  assert.equal(res.json.rank, 1);

  const board = await b.api('GET', '/api/leaderboard');
  assert.equal(board.json.simVersion, SIM_VERSION);
  assert.equal(board.json.entries[0].runId, played.runId);

  // 검증이 끝나면 구간 원본은 지워지고, 리플레이는 공개된 시드와 합친 입력으로 같은 결과를 낸다.
  assert.deepEqual(store.getSegments(played.runId), []);
  assert.equal(store.getRun(played.runId)?.secret, null);
  const replay = await b.api('GET', `/api/runs/${played.runId}/replay`);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.simVersion, SIM_VERSION);
  assert.deepEqual(replay.json.segmentSeeds, played.segmentSeeds);
  const again = simulate(replay.json.seed, replay.json.inputs, { segmentFrames: SEGMENT_FRAMES, segmentSeeds: replay.json.segmentSeeds });
  assert.deepEqual(again, resultOf(played.bot.sim));
});

test('발급 응답은 0번 구간 시드만 공개하고, 비밀 값은 담지 않는다', async () => {
  const issued = await browser().api('POST', '/api/runs');
  assert.equal(issued.status, 201);
  assert.deepEqual(Object.keys(issued.json).sort(), ['runId', 'seed', 'segmentFrames', 'simVersion']);
  assert.equal(issued.json.segmentFrames, SEGMENT_FRAMES);
  assert.equal(issued.json.simVersion, SIM_VERSION);
});

test('다음 구간 시드는 이전 구간 입력이 확정되기 전에는 얻을 수 없다', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const id = issued.json.runId;
  const bot = new BotRun(issued.json.seed);
  const seg0 = bot.playSegment();
  const seg1Guess = { inputs: [4, SEGMENT_FRAMES], final: false };

  // 0번을 건너뛴 1번 구간, 너무 이른 0번 구간 모두 시드를 주지 않는다.
  const skipped = await b.api('POST', `/api/runs/${id}/segments/1`, seg1Guess);
  assert.equal(skipped.status, 409);
  assert.equal(skipped.json.error, 'segment_order');
  assert.equal(skipped.json.next, undefined);

  const early = await b.api('POST', `/api/runs/${id}/segments/0`, { inputs: seg0.runs, final: false });
  assert.equal(early.status, 425);
  assert.equal(early.json.error, 'too_early');
  assert.ok(early.json.retryAfterMs > 0);
  assert.equal(early.json.next, undefined);
  assert.equal(store.getRun(id)?.committed, 0);
  assert.deepEqual(store.getSegments(id), []);

  clock += (SEGMENT_FRAMES / 60) * 1000;
  const ok = await b.api('POST', `/api/runs/${id}/segments/0`, { inputs: seg0.runs, final: false });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.next.index, 1);
  assert.equal(typeof ok.json.next.seed, 'number');
});

test('구간 재전송은 같은 입력에만 같은 응답을 돌려주고 다른 입력은 거절한다', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const id = issued.json.runId;
  const bot = new BotRun(issued.json.seed);
  const seg0 = bot.playSegment();
  clock += (SEGMENT_FRAMES / 60) * 1000;
  const path = `/api/runs/${id}/segments/0`;
  const [a, again] = await Promise.all([
    b.api('POST', path, { inputs: seg0.runs, final: false }),
    b.api('POST', path, { inputs: seg0.runs, final: false }),
  ]);
  const later = await b.api('POST', path, { inputs: seg0.runs, final: false });
  for (const r of [a, again, later]) assert.equal(r.status, 200);
  assert.deepEqual(again.json, a.json);
  assert.deepEqual(later.json, a.json);

  // 다른 입력(마지막 프레임 하나만 다름)은 이미 확정된 구간을 바꿀 수 없다.
  const tampered = [...seg0.runs];
  tampered[0] = tampered[0] === 4 ? 5 : 4; // 첫 입력 코드만 바꾼다(길이는 그대로)
  const conflict = await b.api('POST', path, { inputs: tampered, final: false });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error, 'segment_conflict');
  assert.equal(conflict.json.next, undefined);
  assert.equal(store.getRun(id)?.committed, 1);
  assert.equal(store.getSegments(id).length, 1);

  // 같은 입력이라도 인접 RLE를 다르게 쪼갠 표현은 같은 입력으로 본다.
  const split = seg0.runs.flatMap((v, i, all) => (i % 2 === 1 ? [] : all[i + 1] > 1 ? [v, all[i + 1] - 1, v, 1] : [v, 1]));
  const resplit = await b.api('POST', path, { inputs: split, final: false });
  assert.equal(resplit.status, 200);
  assert.deepEqual(resplit.json, a.json);
});

test('구간 길이와 형식 검증: 중간 구간은 정확히 한 구간, 마지막 구간만 짧을 수 있다', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const id = issued.json.runId;
  const path = `/api/runs/${id}/segments/0`;
  clock += 1000;
  const bad: unknown[] = [
    { inputs: [4, SEGMENT_FRAMES - 1], final: false },
    { inputs: [4, SEGMENT_FRAMES + 1], final: false },
    { inputs: [4, SEGMENT_FRAMES + 1], final: true },
    { inputs: [15, SEGMENT_FRAMES], final: false },
    { inputs: [4, 0], final: true },
    { inputs: [], final: true },
    { inputs: 'x', final: true },
    { inputs: [4, SEGMENT_FRAMES], final: 'yes' },
    {},
  ];
  for (const body of bad) assert.equal((await b.api('POST', path, body)).status, 400, JSON.stringify(body));
  assert.equal(store.getRun(id)?.committed, 0);
  const short = await b.api('POST', path, { inputs: [4, 10], final: true });
  assert.equal(short.status, 200);
  assert.equal(short.json.next, null);
  assert.equal(store.getRun(id)?.status, 'sealed');

  const after = await b.api('POST', `/api/runs/${id}/segments/1`, { inputs: [4, 10], final: true });
  assert.equal(after.status, 409);
  assert.equal(after.json.error, 'run_sealed');
});

test('제출 본문의 inputs는 무시하고 서버가 저장한 입력으로만 점수를 검증한다', async () => {
  const wrong = playBot(7919, undefined, () => 1);

  // 다른 판의 입력과 그 점수를 주장해도, 서버는 저장본으로 재실행하므로 일치하지 않는다.
  const cheat = browser();
  const cheatRun = await playRanked(cheat, clockCtl);
  const forged = await cheat.api('POST', `/api/runs/${cheatRun.runId}/submit`, {
    name: 'forged',
    inputs: [4, 1],
    score: wrong.result.score,
    checksum: wrong.result.checksum,
  });
  assert.equal(forged.status, 422);
  assert.equal(forged.json.error, 'mismatch');

  // 쓸모없는 inputs를 얹어도 저장본의 실제 점수·체크섬이면 통과한다(inputs는 읽지 않는다).
  const honest = browser();
  const honestRun = await playRanked(honest, clockCtl);
  const ok = await honest.api('POST', `/api/runs/${honestRun.runId}/submit`, { ...submitBody(honestRun), inputs: [4, 1] });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.score, honestRun.result.score);
});

test('점수를 부풀려 제출하면 거부되고 같은 판 재제출도 막힌다', async () => {
  const b = browser();
  const played = await playRanked(b, clockCtl);
  const body = { name: 'cheater', score: played.result.score + 100000, checksum: played.result.checksum };
  const res = await b.api('POST', `/api/runs/${played.runId}/submit`, body);
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'mismatch');
  assert.equal(store.getRun(played.runId)?.status, 'rejected');
  assert.equal(store.getRun(played.runId)?.reject_reason, 'mismatch');
  assert.deepEqual(store.getSegments(played.runId), []);

  const retry = await b.api('POST', `/api/runs/${played.runId}/submit`, body);
  assert.equal(retry.status, 409);
  assert.equal(retry.json.error, 'run_closed');
  const board = await b.api('GET', '/api/leaderboard');
  assert.ok(!board.json.entries.some((e: any) => e.runId === played.runId));
});

test('같은 판은 두 번 검증되지 않고, 같은 점수·체크섬의 재전송은 같은 성공 응답을 받는다', async () => {
  const b = browser();
  const played = await playRanked(b, clockCtl);
  const body = submitBody(played, 'a');
  const [x, y] = await Promise.all([
    b.api('POST', `/api/runs/${played.runId}/submit`, body),
    b.api('POST', `/api/runs/${played.runId}/submit`, body),
  ]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const winner = x.status === 200 ? x : y;
  const lost = x.status === 200 ? y : x;
  assert.equal(lost.json.error, 'already_submitted');

  // 응답이 유실됐다고 보고 다시 보내면 같은 결과가 돌아온다(다시 검증하지 않는다).
  const retry = await b.api('POST', `/api/runs/${played.runId}/submit`, { ...body, name: 'changed' });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, winner.json);
  // 다른 점수를 주장하면 이미 제출된 판이다.
  const other = await b.api('POST', `/api/runs/${played.runId}/submit`, { ...body, score: body.score + 1 });
  assert.equal(other.status, 409);
  assert.equal(other.json.error, 'already_submitted');
});

test('끝나지 않은 판은 기록되지 않는다', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const id = issued.json.runId;
  const bot = new BotRun(issued.json.seed);
  const seg = bot.playSegment(30);
  clock += 1000;
  assert.equal((await b.api('POST', `/api/runs/${id}/segments/0`, { inputs: seg.runs, final: true })).status, 200);
  const result = resultOf(bot.sim);
  const res = await b.api('POST', `/api/runs/${id}/submit`, { name: 'quit', score: result.score, checksum: result.checksum });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'unfinished');
});

test('마지막 구간이 확정되지 않은 판은 제출할 수 없다', async () => {
  const b = browser();
  const played = await playRanked(b, clockCtl, 2);
  const res = await b.api('POST', `/api/runs/${played.runId}/submit`, submitBody(played));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'not_sealed');
  assert.equal(store.getRun(played.runId)?.status, 'issued');
});

test('판 소유권: 다른 브라우저나 쿠키 없는 요청은 구간 입력도 제출도 할 수 없다', async () => {
  const owner = browser();
  const issued = await owner.api('POST', '/api/runs');
  const id = issued.json.runId;
  const bot = new BotRun(issued.json.seed);
  const seg = bot.playSegment();
  clock += (SEGMENT_FRAMES / 60) * 1000;

  const stranger = browser();
  await stranger.api('POST', '/api/runs'); // 자기 세션은 있지만 이 판의 소유자는 아니다
  const nobody = browser();
  for (const who of [stranger, nobody]) {
    const segRes = await who.api('POST', `/api/runs/${id}/segments/0`, { inputs: seg.runs, final: false });
    assert.equal(segRes.status, 403);
    assert.equal(segRes.json.next, undefined);
    const subRes = await who.api('POST', `/api/runs/${id}/submit`, { score: 1, checksum: 1 });
    assert.equal(subRes.status, 403);
  }
  assert.equal(store.getRun(id)?.committed, 0);

  // 서버가 발급하지 않은 쿠키 값은 세션이 아니며, 발급 때 그 값을 세션으로 채택하지도 않는다.
  const forged = browser();
  forged.cookie = `ember_sid=${'A'.repeat(43)}`;
  assert.equal((await forged.api('POST', `/api/runs/${id}/segments/0`, { inputs: seg.runs, final: false })).status, 403);
  const issuedForged = await forged.api('POST', '/api/runs');
  assert.equal(issuedForged.status, 201);
  assert.ok(!issuedForged.headers.get('set-cookie')!.includes('A'.repeat(43)));

  assert.equal((await owner.api('POST', `/api/runs/${id}/segments/0`, { inputs: seg.runs, final: false })).status, 200);
});

test('세션 쿠키는 HttpOnly·SameSite=Strict이고 값은 DB에 해시로만 남는다', async () => {
  const b = browser();
  const res = await fetch(`${base}/api/runs`, { method: 'POST' });
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /^ember_sid=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Strict/);
  assert.match(cookie, /; Path=\//);
  assert.doesNotMatch(cookie, /Secure/); // 평문 HTTP 접속에는 붙이지 않는다
  const token = /^ember_sid=([^;]+)/.exec(cookie)![1];
  const ids = (db.prepare('SELECT id FROM sessions').all() as { id: string }[]).map((r) => r.id);
  assert.ok(!ids.includes(token));
  void b;
});

test('브라우저가 다른 출처·같은 사이트의 다른 출처라고 밝힌 쓰기 요청은 거절한다', async () => {
  const b = browser();
  for (const site of ['cross-site', 'same-site']) {
    assert.equal((await b.api('POST', '/api/runs', undefined, { 'Sec-Fetch-Site': site })).status, 403, site);
  }
  // 프록시가 Host를 바꿔도(Origin과 Host가 달라도) 같은 출처 요청은 통과한다.
  const proxied = { Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'same-origin' };
  assert.equal((await b.api('POST', '/api/runs', undefined, proxied)).status, 201);
  assert.equal((await b.api('POST', '/api/runs', undefined, { 'Sec-Fetch-Site': 'none' })).status, 201);
});

test('플레이 시간보다 빨리 확정하려는 구간은 시드를 주지 않는다 (배속/오프라인 계산)', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const bot = new BotRun(issued.json.seed);
  const seg = bot.playSegment();
  clock += 100; // 1초짜리 구간을 0.1초 만에
  const res = await b.api('POST', `/api/runs/${issued.json.runId}/segments/0`, { inputs: seg.runs, final: false });
  assert.equal(res.status, 425);
});

test('발급 후 20분이 지나면 구간 확정을 거부한다', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const bot = new BotRun(issued.json.seed);
  const seg = bot.playSegment();
  clock += 20 * 60 * 1000 + 1;
  const res = await b.api('POST', `/api/runs/${issued.json.runId}/segments/0`, { inputs: seg.runs, final: false });
  assert.equal(res.status, 422);
  assert.equal(res.json.error, 'expired');
  assert.equal(store.getRun(issued.json.runId)?.status, 'rejected');
});

/** 구간 하나만 확정한 판에서, 다음 구간을 시드 공개 후 waitMs 뒤에 보낸다. */
async function commitSecondSegmentAfter(waitMs: number) {
  const b = browser();
  const played = await playRanked(b, clockCtl, 1);
  const bot = new BotRun(played.seed);
  bot.playSegment();
  bot.nextSegment(played.segmentSeeds[0]);
  const seg1 = bot.playSegment(SEGMENT_FRAMES);
  clock += waitMs;
  const res = await b.api('POST', `/api/runs/${played.runId}/segments/1`, { inputs: seg1.runs, final: false });
  return { res, played };
}

test('공개한 구간 시드를 오래 들고 있던 판은 거절한다: 정상 1초 + 고정 여유 5초', async () => {
  const limit = 1000 + sharedLimits.segmentGraceMs;
  const late = await commitSecondSegmentAfter(limit + 1);
  assert.equal(late.res.status, 422);
  assert.equal(late.res.json.error, 'timeout');
  assert.equal(late.res.json.next, undefined);
  assert.equal(store.getRun(late.played.runId)?.reject_reason, 'timeout');
  assert.deepEqual(store.getSegments(late.played.runId), []);

  // 기한 안(일시정지·레벨업 선택·네트워크 지연 포함)이면 정상 확정된다. 경계는 포함.
  const edge = await commitSecondSegmentAfter(limit);
  assert.equal(edge.res.status, 200);
  assert.equal(edge.res.json.next.index, 2);
});

test('기한을 넘긴 뒤에도 이미 확정된 구간의 같은 입력 재전송은 같은 응답을 받는다', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const bot = new BotRun(issued.json.seed);
  const seg = bot.playSegment();
  clock += 1000;
  const path = `/api/runs/${issued.json.runId}/segments/0`;
  const first = await b.api('POST', path, { inputs: seg.runs, final: false });
  assert.equal(first.status, 200);
  clock += 60_000; // 응답이 유실된 채로 오래 지난 재시도
  const retry = await b.api('POST', path, { inputs: seg.runs, final: false });
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.json, first.json);
});

test('세션당 열린 판은 3개로 제한하고 가장 오래된 판을 무효화한다', async () => {
  const b = browser();
  const first = await b.api('POST', '/api/runs');
  const bot = new BotRun(first.json.seed);
  const seg = bot.playSegment();
  const issued = [first];
  for (let i = 0; i < 3; i++) issued.push(await b.api('POST', '/api/runs'));

  assert.equal(first.status, 201);
  assert.equal(store.getRun(first.json.runId)?.status, 'rejected');
  for (const run of issued.slice(1)) {
    assert.equal(run.status, 201);
    assert.equal(store.getRun(run.json.runId)?.status, 'issued');
  }
  clock += (SEGMENT_FRAMES / 60) * 1000;
  const res = await b.api('POST', `/api/runs/${first.json.runId}/segments/0`, { inputs: seg.runs, final: false });
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'abandoned');
});

test('같은 세션은 30분에 6판까지 발급받고 폐기된 판도 이력에 포함한다', async () => {
  const b = browser();
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await b.api('POST', '/api/runs');
    assert.equal(res.status, 201);
    ids.push(res.json.runId);
    clock += 1000;
  }
  // 6판 중 3판은 이미 폐기됐지만 이력에는 남아 있다.
  assert.equal(ids.filter((id) => store.getRun(id)?.reject_reason === 'abandoned').length, 3);
  const blocked = await b.api('POST', '/api/runs');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error, 'quota_exceeded');
  assert.ok(blocked.json.retryAfterMs > 0);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);

  clock += blocked.json.retryAfterMs;
  const retried = await b.api('POST', '/api/runs');
  assert.equal(retried.status, 201, JSON.stringify(retried.json));
});

test('검증 장애 후 같은 판을 재제출하면 검증되어 리더보드에 오른다', async () => {
  const failureStore = new Store(':memory:', sharedLimits);
  const failures = [new VerifyTimeoutError('test timeout'), new QueueFullError('test queue full')];
  const failureServer = createApp({
    store: failureStore,
    verify: async (seed, runs, rules) => {
      const failure = failures.shift();
      if (failure) throw failure;
      return pool.verify(seed, runs, rules);
    },
    now: () => clock,
    limits: sharedLimits,
  });
  try {
    await new Promise<void>((resolve) => failureServer.listen(0, resolve));
    const b = new Browser(`http://127.0.0.1:${(failureServer.address() as AddressInfo).port}`);
    const played = await playRanked(b, clockCtl);
    const body = submitBody(played, '재제출');

    for (const expectedError of ['verify_error', 'server_busy']) {
      const response = await b.api('POST', `/api/runs/${played.runId}/submit`, body);
      assert.equal(response.status, 503);
      assert.equal(response.json.error, expectedError);
      assert.equal(failureStore.getRun(played.runId)?.status, 'sealed');
      assert.equal(failureStore.getRun(played.runId)?.reject_reason, null);
      assert.ok(failureStore.getSegments(played.runId).length > 0, '재시도를 위해 서버 저장본을 유지한다');
    }
    const response = await b.api('POST', `/api/runs/${played.runId}/submit`, body);
    assert.equal(response.status, 200);
    assert.equal(failureStore.getRun(played.runId)?.status, 'verified');
    const board = await b.api('GET', '/api/leaderboard');
    assert.ok(board.json.entries.some((entry: { runId: string }) => entry.runId === played.runId));
  } finally {
    await new Promise<void>((resolve, reject) => failureServer.close((err) => (err ? reject(err) : resolve())));
    failureStore.close();
  }
});

test('이전 규칙(v2) 리플레이는 그대로 조회되고 현재 리더보드에는 섞이지 않는다', async () => {
  const legacy = playBot(7919);
  const id = '00000000-0000-4000-8000-0000000000a2';
  db.prepare(
    `INSERT INTO runs (id, seed, sim_version, ip, issued_at, status, name, score, kills, ticks, level, won, inputs, submitted_at)
     VALUES (?, 7919, 2, '127.0.0.9', 1, 'verified', '옛기록', ?, 1, ?, 1, 1, ?, 2)`,
  ).run(id, legacy.result.score, legacy.result.ticks, JSON.stringify(legacy.runs));

  const b = browser();
  const replay = await b.api('GET', `/api/runs/${id}/replay`);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.simVersion, 2);
  assert.deepEqual(replay.json.segmentSeeds, []);
  assert.deepEqual(simulate(replay.json.seed, replay.json.inputs), legacy.result);

  const current = await b.api('GET', '/api/leaderboard?limit=50');
  assert.ok(!current.json.entries.some((e: { runId: string }) => e.runId === id));
  const old = await b.api('GET', '/api/leaderboard?version=2');
  assert.equal(old.json.simVersion, 2);
  assert.deepEqual(old.json.entries.map((e: { runId: string }) => e.runId), [id]);
  assert.equal((await b.api('GET', '/api/leaderboard?version=9')).status, 400);
});

test('health check는 검증 풀이나 DB가 닫히면 503을 반환한다', async () => {
  assert.equal((await browser().api('GET', '/api/health')).status, 200);

  const healthStore = new Store(':memory:');
  let verifierHealthy = true;
  const healthServer = createApp({
    store: healthStore,
    verify: async () => { throw new Error('이 테스트에서는 검증을 호출하지 않는다'); },
    healthy: () => verifierHealthy,
  });
  try {
    await new Promise<void>((resolve) => healthServer.listen(0, resolve));
    const healthBase = `http://127.0.0.1:${(healthServer.address() as AddressInfo).port}`;
    const poolFailure = await fetch(`${healthBase}/api/health`);
    assert.equal(poolFailure.status, 200);

    verifierHealthy = false;
    const closedPool = await fetch(`${healthBase}/api/health`);
    assert.equal(closedPool.status, 503);
    assert.equal((await closedPool.json() as { ok: boolean }).ok, false);

    verifierHealthy = true;
    healthStore.close();
    const closedStore = await fetch(`${healthBase}/api/health`);
    assert.equal(closedStore.status, 503);
    assert.equal((await closedStore.json() as { ok: boolean }).ok, false);
  } finally {
    await new Promise<void>((resolve, reject) => healthServer.close((err) => err ? reject(err) : resolve()));
    healthStore.close();
  }
});

test('형식이 잘못된 요청은 400/403/404', async () => {
  const b = browser();
  const issued = await b.api('POST', '/api/runs');
  const id = issued.json.runId;
  assert.equal((await b.api('POST', `/api/runs/${id}/submit`, { score: 1.5, checksum: 1 })).status, 400);
  assert.equal((await b.api('POST', `/api/runs/${id}/submit`, { score: 'x', checksum: 1 })).status, 400);
  assert.equal((await b.api('POST', `/api/runs/not-a-uuid/submit`, { score: 1, checksum: 1 })).status, 404);
  assert.equal((await b.api('GET', `/api/runs/${id}/replay`)).status, 404); // 검증 전에는 비공개
  const unknown = '00000000-0000-4000-8000-000000000000';
  assert.equal((await b.api('POST', `/api/runs/${unknown}/submit`, { score: 1, checksum: 1 })).status, 404);
  assert.equal((await browser().api('POST', `/api/runs/${unknown}/submit`, { score: 1, checksum: 1 })).status, 403);
});

test('토큰 버킷 속도 제한', () => {
  const rl = new RateLimiter(3, 60);
  assert.deepEqual([rl.take('a', 0), rl.take('a', 0), rl.take('a', 0), rl.take('a', 0)], [true, true, true, false]);
  assert.equal(rl.take('b', 0), true); // 다른 키는 독립
  assert.equal(rl.take('a', 1000), true); // 1초 뒤 1개 충전
  assert.equal(rl.take('a', 1000), false);
});

test('이름 정리', () => {
  assert.equal(cleanName('  a\tb  '), 'a b');
  assert.equal(cleanName('<script>alert(1)</script>'), '<script>aler');
  assert.equal(cleanName(''), '익명');
  assert.equal(cleanName(42), '익명');
  assert.equal(cleanName('가나다라마바사아자차카타파하'), '가나다라마바사아자차카타');
});

test('선점 직전에 무효화된 판은 최신 상태를 다시 읽어 abandoned로 응답한다', async () => {
  // 같은 요청 안에서 상태를 읽은 뒤 claim 사이에 다른 요청이 판을 폐기한 경쟁을 재현한다.
  const raceStore = new Store(':memory:', sharedLimits);
  const claim = raceStore.claim.bind(raceStore);
  let invalidate = false;
  raceStore.claim = (id) => {
    if (invalidate) {
      invalidate = false;
      raceStore.markRejected(id, 'abandoned', clock);
    }
    return claim(id);
  };
  const raceServer = createApp({
    store: raceStore,
    verify: async () => { throw new Error('claim 실패 뒤 검증은 호출하지 않는다'); },
    now: () => clock,
    limits: sharedLimits,
  });
  try {
    await new Promise<void>((resolve) => raceServer.listen(0, resolve));
    const b = new Browser(`http://127.0.0.1:${(raceServer.address() as AddressInfo).port}`);
    const played = await playRanked(b, clockCtl);
    invalidate = true;
    const res = await b.api('POST', `/api/runs/${played.runId}/submit`, submitBody(played));
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'abandoned');
    assert.equal(raceStore.getRun(played.runId)?.reject_reason, 'abandoned');
  } finally {
    await new Promise<void>((resolve, reject) => raceServer.close((err) => (err ? reject(err) : resolve())));
    raceStore.close();
  }
});

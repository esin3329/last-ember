// HTTP API. 의존성(저장소, 검증기, 시계)을 주입받아서 테스트에서 가짜 시계와
// 메모리 DB로 그대로 띄울 수 있다.
//
// 랭킹(v3) 흐름. 모든 쓰기 요청은 같은 사이트의 HttpOnly 세션 쿠키로 소유권을 확인한다.
//   1. POST /api/runs                       판 발급. 0번 구간 시드만 공개한다.
//   2. (클라이언트가 구간 하나를 플레이하며 입력 프레임을 기록)
//   3. POST /api/runs/:id/segments/:index   구간 입력을 서버에 저장(확정). 응답으로 다음 구간 시드를 받는다.
//                                           확정되기 전에는 다음 구간 시드를 알 수 없다.
//   4. POST /api/runs/:id/submit            마지막 구간이 확정된 뒤 점수·체크섬을 주장한다.
//                                           서버는 자기가 저장한 입력만으로 재실행해 대조한다.
//   5. GET  /api/leaderboard                검증된 기록만 노출
//   6. GET  /api/runs/:id/replay            검증된 판의 시드(+v3면 구간 시드)와 입력

import { randomBytes, randomUUID } from 'node:crypto';
import { NO_TRUSTED_PROXY, type TrustProxyConfig, isTrustedPeer, resolveClientIp } from './trustedProxy.ts';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { SEGMENT_FRAMES, SIM_VERSION, TICK_RATE, rulesFor } from '../../shared/defs.ts';
import { countTicks } from '../../shared/input.ts';
import type { AppLogEvent } from './logging.ts';
import {
  MAX_RUN_FRAMES,
  MAX_SEGMENTS,
  RANKED_LIMITS,
  RUN_RETENTION_MS,
  SESSION_RETENTION_MS,
  type RankedLimits,
  hashSessionToken,
  newSessionToken,
  normalizeRuns,
  readSessionToken,
  segmentSeed,
  sessionCookie,
} from './ranked.ts';
import { RateLimiter } from './rateLimit.ts';
import { serveStatic } from './static.ts';
import type { IssueError, RunRow, Store } from './store.ts';
import { QueueFullError, VerifyError, type VerifyFn } from './verifier.ts';

export interface AppDeps {
  store: Store;
  verify: VerifyFn;
  now?: () => number;
  trustProxy?: TrustProxyConfig;
  staticDir?: string;
  log?: (event: AppLogEvent) => void;
  healthy?: () => boolean;
  limits?: RankedLimits;
}

class HttpError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  headers: Record<string, string>;
  constructor(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
    this.headers = headers;
  }
}

// 구간 입력(60프레임 RLE)과 제출 본문(이름·점수·체크섬)은 모두 작다.
const MAX_BODY = 4 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 구간을 플레이하는 데 최소한 걸려야 하는 시간 비율과 여유. 실제 60Hz보다 빠른 제출을 막는다. */
const MIN_SEGMENT_RATIO = 0.9;
const MIN_SEGMENT_SLACK_MS = 50;

function readJson(req: IncomingMessage, maxBody = MAX_BODY): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBody) {
        reject(new HttpError(413, 'body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/** 표시용 이름 정리: 제어 문자 제거, 공백 정리, 12자 제한. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '익명';
  // \p{C}: 제어·서식 문자(널, 줄바꿈, 방향 전환 문자 등) 전체
  const name = [...raw.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim()]
    .slice(0, 12)
    .join('');
  return name || '익명';
}

const ISSUE_STATUS: Record<IssueError, [number, string]> = {
  session_quota: [429, 'quota_exceeded'],
  ip_quota: [429, 'ip_quota_exceeded'],
  ip_open: [429, 'ip_quota_exceeded'],
  ip_sessions: [429, 'ip_quota_exceeded'],
  busy: [503, 'server_busy'],
};

export function createApp(deps: AppDeps): Server {
  const { store, verify } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const limits = deps.limits ?? RANKED_LIMITS;
  const trustProxy = deps.trustProxy ?? NO_TRUSTED_PROXY;
  const issueLimit = new RateLimiter(20, 20);
  const submitLimit = new RateLimiter(10, 10);
  const readLimit = new RateLimiter(120, 120);
  // 구간 전송은 정상 속도에서 한 판에 분당 약 60회다. 세션별(동시에 연 판 몇 개)과 IP별(공유 NAT) 두 겹으로 제한한다.
  const segmentSessionLimit = new RateLimiter(40, 120);
  const segmentIpLimit = new RateLimiter(600, 1200);

  /**
   * 상태를 바꾸는 요청은 브라우저가 같은 출처(또는 주소창 직접 입력)에서 보냈다고 밝힌 것만 받는다.
   * SameSite=Strict 쿠키에 더한 두 번째 방어다. Sec-Fetch-Site는 페이지 스크립트가 바꿀 수 없다.
   * Origin과 Host를 비교하지 않는 이유: 리버스 프록시나 개발 서버 프록시가 Host를 업스트림 주소로 바꾸는 배포가 흔하다.
   */
  function requireSameSite(req: IncomingMessage): void {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'cross_site');
  }

  function isSecure(req: IncomingMessage): boolean {
    if ((req.socket as TLSSocket).encrypted === true) return true;
    // X-Forwarded-Proto는 신뢰 프록시 대역에서 온 연결에서만 읽는다.
    if (!isTrustedPeer(req.socket.remoteAddress, trustProxy)) return false;
    const proto = req.headers['x-forwarded-proto'];
    const last = (Array.isArray(proto) ? proto.join(',') : (proto ?? '')).split(',').pop()?.trim();
    return last === 'https';
  }

  /** 쿠키가 가리키는 기존 세션의 해시. 서버가 발급하지 않은 토큰은 세션으로 보지 않는다. */
  function existingSession(req: IncomingMessage): string | null {
    const token = readSessionToken(req);
    if (!token) return null;
    const hash = hashSessionToken(token);
    return store.hasSession(hash) ? hash : null;
  }

  function ownedRun(id: string, session: string | null): RunRow {
    if (!session) throw new HttpError(403, 'no_session');
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, 'run_not_found');
    if (run.session_id !== session) throw new HttpError(403, 'not_owner');
    return run;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ip = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], trustProxy);
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
      if (deps.staticDir && (await serveStatic(deps.staticDir, path, res))) return;
      throw new HttpError(404, 'not_found');
    }

    if (method === 'GET' && path === '/api/health') {
      const ok = !store.isClosed && (deps.healthy?.() ?? true);
      return send(res, ok ? 200 : 503, { ok, simVersion: SIM_VERSION });
    }

    if (method === 'POST' && path === '/api/runs') {
      requireSameSite(req);
      if (!issueLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
      const known = existingSession(req);
      const token = known ? readSessionToken(req)! : newSessionToken();
      const secret = randomBytes(32);
      const runId = randomUUID();
      const seed = segmentSeed(secret, 0);
      const issued = store.issueRun({
        runId,
        seed,
        secret,
        simVersion: SIM_VERSION,
        sessionHash: known ?? hashSessionToken(token),
        ip,
        now: now(),
      });
      if (!issued.ok) {
        const [status, code] = ISSUE_STATUS[issued.error];
        throw new HttpError(status, code, { retryAfterMs: issued.retryAfterMs }, {
          'Retry-After': String(Math.ceil(issued.retryAfterMs / 1000)),
        });
      }
      return send(
        res,
        201,
        { runId, seed, simVersion: SIM_VERSION, segmentFrames: SEGMENT_FRAMES },
        { 'Set-Cookie': sessionCookie(token, isSecure(req)) },
      );
    }

    if (method === 'GET' && path === '/api/leaderboard') {
      if (!readLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      // 지난 규칙(v2)의 기록도 version=2로 조회할 수 있다.
      const version = Number(url.searchParams.get('version') ?? SIM_VERSION);
      if (!rulesFor(version)) throw new HttpError(400, 'unknown_version');
      const rows = store.leaderboard(version, limit).map((r, i) => ({
        rank: i + 1,
        runId: r.id,
        name: r.name,
        score: r.score,
        kills: r.kills,
        seconds: Math.floor(r.ticks / TICK_RATE),
        level: r.level,
        won: r.won === 1,
      }));
      return send(res, 200, { entries: rows, simVersion: version });
    }

    const m = /^\/api\/runs\/([^/]+)\/(submit|replay|segments\/(\d{1,3}))$/.exec(path);
    if (m) {
      const id = m[1];
      if (!UUID_RE.test(id)) throw new HttpError(404, 'run_not_found');

      if (m[2] === 'replay' && method === 'GET') {
        if (!readLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
        const run = store.getRun(id);
        if (!run || run.status !== 'verified' || !run.inputs) throw new HttpError(404, 'run_not_found');
        return send(res, 200, {
          seed: run.seed,
          simVersion: run.sim_version,
          segmentSeeds: run.seg_seeds ? JSON.parse(run.seg_seeds) : [],
          name: run.name,
          score: run.score,
          inputs: JSON.parse(run.inputs),
        });
      }

      if (m[2] === 'submit' && method === 'POST') {
        requireSameSite(req);
        if (!submitLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
        const session = existingSession(req);
        if (!session) throw new HttpError(403, 'no_session');
        const body = (await readJson(req)) as Record<string, unknown>;
        // 본문을 읽는 동안 판 상태가 바뀔 수 있으므로 판은 본문을 읽은 뒤에 불러온다.
        return submit(ownedRun(id, session), body, res);
      }

      if (m[3] !== undefined && method === 'POST') {
        requireSameSite(req);
        if (!segmentIpLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
        const session = existingSession(req);
        if (!session) throw new HttpError(403, 'no_session');
        if (!segmentSessionLimit.take(session, now())) throw new HttpError(429, 'rate_limited');
        const body = (await readJson(req)) as Record<string, unknown>;
        return commitSegment(ownedRun(id, session), Number(m[3]), body, res);
      }
    }

    throw new HttpError(404, 'not_found');
  }

  /** 진행 중이 아닌 판에 대한 구간·제출 요청을 구별되는 오류로 돌려준다. */
  function closedRunError(run: RunRow): HttpError | null {
    if (run.status === 'rejected') {
      const reason = run.reject_reason;
      return new HttpError(409, reason === 'abandoned' || reason === 'expired' || reason === 'timeout' ? reason : 'run_closed');
    }
    if (run.status === 'verifying' || run.status === 'verified') return new HttpError(409, 'already_submitted');
    return null;
  }

  function expire(run: RunRow): never {
    store.markRejected(run.id, 'expired', now());
    log({ event: 'run_rejected', runId: run.id, reason: 'expired' });
    throw new HttpError(422, 'expired');
  }

  function commitSegment(run: RunRow, index: number, body: Record<string, unknown>, res: ServerResponse): void {
    // 1) 형식: 비싼 일을 하기 전에 싸게 걸러낼 수 있는 것부터.
    const frames = countTicks(body?.inputs, SEGMENT_FRAMES);
    const final = body?.final === true;
    if (frames < 1 || (body?.final !== undefined && typeof body.final !== 'boolean') || (!final && frames !== SEGMENT_FRAMES)) {
      throw new HttpError(400, 'invalid_payload');
    }
    if (run.sim_version !== SIM_VERSION) throw new HttpError(409, 'version_mismatch');
    const closed = closedRunError(run);
    if (closed) throw closed;

    const inputs = JSON.stringify(normalizeRuns(body.inputs as number[]));
    const reply = (final_: boolean): void => {
      const next = final_ ? null : { index: index + 1, seed: segmentSeed(run.secret!, index + 1) };
      send(res, 200, { ok: true, index, final: final_, next });
    };

    // 2) 이미 확정된 구간: 같은 입력의 재전송만 같은 응답을 돌려주고, 다른 입력은 거절한다.
    if (index < run.committed) {
      const stored = store.getSegment(run.id, index);
      if (!stored || stored.inputs !== inputs || (stored.final === 1) !== final) throw new HttpError(409, 'segment_conflict');
      return reply(final);
    }
    if (run.status === 'sealed') throw new HttpError(409, 'run_sealed');
    if (index > run.committed) throw new HttpError(409, 'segment_order');

    // 3) 기한: 이전 구간 시드를 공개한 뒤 너무 오래 들고 있던 판은 거절한다(시드를 쥔 채 오프라인에서 탐색하는 시간 제한).
    const current = now();
    if (current - run.issued_at > limits.maxRunAgeMs) expire(run);
    const deadline = (frames * 1000) / TICK_RATE + limits.segmentGraceMs;
    const elapsed = current - (run.seg_at ?? run.issued_at);
    if (elapsed > deadline) {
      store.markRejected(run.id, 'timeout', current);
      log({ event: 'run_rejected', runId: run.id, reason: 'timeout' });
      throw new HttpError(422, 'timeout');
    }
    if (run.frames + frames > MAX_RUN_FRAMES || (!final && index + 1 >= MAX_SEGMENTS)) {
      store.markRejected(run.id, 'too_long', current);
      log({ event: 'run_rejected', runId: run.id, reason: 'too_long' });
      throw new HttpError(422, 'too_long');
    }
    // 최소 소요 시간: 서버가 시드를 보낸 뒤 실제 플레이 시간만큼은 지나야 한다(60Hz보다 빠른 계산·배속 차단).
    // 서버가 잰 시간에는 왕복 지연이 포함되므로 정상 클라이언트는 항상 이 값을 넘는다.
    const minElapsed = ((frames * 1000) / TICK_RATE) * MIN_SEGMENT_RATIO - MIN_SEGMENT_SLACK_MS;
    if (elapsed < minElapsed) {
      // 판은 그대로 두고 기다리게 한다. 아무것도 저장하지 않았고 다음 시드도 공개하지 않았다.
      const retryAfterMs = Math.ceil(minElapsed - elapsed);
      throw new HttpError(425, 'too_early', { retryAfterMs }, { 'Retry-After': String(Math.ceil(retryAfterMs / 1000)) });
    }

    if (!store.appendSegment(run.id, index, inputs, frames, final, current)) throw new HttpError(409, 'segment_order');
    reply(final);
  }

  async function submit(run: RunRow, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const id = run.id;
    // 1) 형식. 입력은 받지 않는다: 점수 검증은 서버가 저장한 구간 입력만 쓴다.
    const claimedScore = body?.score;
    const claimedSum = body?.checksum;
    if (!Number.isInteger(claimedScore) || !Number.isInteger(claimedSum)) {
      throw new HttpError(400, 'invalid_payload');
    }
    if (run.sim_version !== SIM_VERSION) throw new HttpError(409, 'version_mismatch');
    // 같은 점수·체크섬의 재전송은 응답이 유실된 성공 제출로 보고 같은 결과를 다시 돌려준다.
    if (run.status === 'verified' && run.score === claimedScore && run.checksum === claimedSum) {
      return send(res, 200, {
        ok: true,
        name: run.name,
        score: run.score,
        kills: run.kills,
        won: run.won === 1,
        rank: store.rankOf(SIM_VERSION, run.score!),
      });
    }
    const closed = closedRunError(run);
    if (closed) throw closed;
    if (run.status === 'issued') throw new HttpError(409, 'not_sealed');

    // 2) 한 번만 제출 가능 (원자적 선점)
    if (!store.claim(id)) {
      // 선점에 실패했다면 그 사이 판 상태가 바뀐 것이다(무효화·만료·다른 제출). 최신 상태로 이유를 구별한다.
      const latest = store.getRun(id);
      throw (latest && closedRunError(latest)) || new HttpError(409, 'already_submitted');
    }

    const reject = (reason: string): never => {
      store.markRejected(id, reason, now());
      log({ event: 'run_rejected', runId: id, reason });
      throw new HttpError(422, reason);
    };

    // 3) 최소·최대 경과 시간 검사: 너무 빠른 제출과 오래된 발급 판 재사용을 제한한다.
    const elapsed = now() - run.issued_at;
    if (elapsed > limits.maxRunAgeMs) reject('expired');
    const minElapsed = (run.frames / TICK_RATE) * 1000 * 0.9 - 2000;
    if (elapsed < minElapsed) reject('too_fast');

    // 4) 서버가 저장한 구간 입력으로만 재실행
    const segments = store.getSegments(id);
    const last = segments[segments.length - 1];
    if (!run.secret || segments.length !== run.committed || last?.final !== 1) {
      store.releaseClaim(id);
      throw new Error(`run ${id} has inconsistent stored segments`);
    }
    const runs = segments.flatMap((s) => JSON.parse(s.inputs) as number[]);
    const segmentSeeds = segments.slice(1).map((_, i) => segmentSeed(run.secret!, i + 1));
    let result;
    try {
      result = await verify(run.seed, runs, { segmentFrames: rulesFor(run.sim_version)!.segmentFrames, segmentSeeds });
    } catch (err) {
      if (err instanceof QueueFullError) {
        store.releaseClaim(id);
        log({ event: 'verification_unavailable', runId: id, reason: 'server_busy' });
        throw new HttpError(503, 'server_busy');
      }
      if (err instanceof VerifyError) {
        store.releaseClaim(id);
        log({ event: 'verification_unavailable', runId: id, reason: 'verify_error' });
        throw new HttpError(503, 'verify_error');
      }
      store.markRejected(id, 'verify_error', now());
      throw err;
    }
    if (!result.finished) reject('unfinished');
    if (result.score !== claimedScore || result.checksum !== claimedSum) reject('mismatch');

    const name = cleanName(body.name);
    store.markVerified(
      id,
      {
        name,
        score: result.score,
        kills: result.kills,
        ticks: result.ticks,
        level: result.level,
        won: result.won,
        inputs: JSON.stringify(normalizeRuns(runs)),
        segmentSeeds: JSON.stringify(segmentSeeds),
        checksum: claimedSum as number,
      },
      now(),
    );
    log({ event: 'run_verified', runId: id, score: result.score, ticks: result.ticks });
    send(res, 200, {
      ok: true,
      name,
      score: result.score,
      kills: result.kills,
      won: result.won,
      rank: store.rankOf(SIM_VERSION, result.score),
    });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, ...err.extra }, err.headers);
      log({ event: 'request_error', message: String(err) });
      send(res, 500, { error: 'internal' });
    });
  });

  // 주기 정리: 입력이 끊긴 판과 프로세스 중단으로 남은 검증 작업, 오래된 세션, 한도 밖 기록, 한가한 속도 제한 버킷
  const timer = setInterval(() => {
    const current = now();
    store.expireOpen(current);
    store.purgeStale(current - RUN_RETENTION_MS, current);
    store.purgeSessions(current - SESSION_RETENTION_MS);
    store.trimBoard(SIM_VERSION, limits.boardKeep);
    for (const l of [issueLimit, submitLimit, readLimit, segmentSessionLimit, segmentIpLimit]) l.sweep(current);
  }, 10 * 60 * 1000);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  return server;
}

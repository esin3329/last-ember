// HTTP API. 의존성(저장소, 검증기, 시계)을 주입받아서 테스트에서 가짜 시계와
// 메모리 DB로 그대로 띄울 수 있다.
//
// 흐름:
//   1. POST /api/runs               서버가 시드를 발급 (클라이언트가 시드를 고를 수 없음)
//   2. (클라이언트에서 플레이, 입력을 틱 단위로 기록)
//   3. POST /api/runs/:id/submit    입력 로그 제출 → 서버가 같은 시뮬레이션을 재실행
//                                   → 재실행 결과가 주장한 점수/체크섬과 같을 때만 기록
//   4. GET  /api/leaderboard        검증된 기록만 노출
//   5. GET  /api/runs/:id/replay    검증된 판의 시드+입력 (클라이언트가 그대로 재생)

import { randomInt, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { MAX_TICKS, SIM_VERSION, TICK_RATE } from '../../shared/defs.ts';
import { countTicks } from '../../shared/input.ts';
import { RateLimiter } from './rateLimit.ts';
import { serveStatic } from './static.ts';
import type { Store } from './store.ts';
import { QueueFullError, VerifyError, type VerifyFn } from './verifier.ts';

export interface AppDeps {
  store: Store;
  verify: VerifyFn;
  now?: () => number;
  trustProxyHops?: number;
  staticDir?: string;
  log?: (line: string) => void;
  healthy?: () => boolean;
}

class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const MAX_BODY = 512 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ISSUED_RUNS_PER_IP = 3;
const MAX_RUN_AGE_MS = (MAX_TICKS / TICK_RATE) * 1000 + 10 * 60 * 1000;

/** 잘못된 신뢰 경계 설정은 요청 처리 전에 실패시킨다. */
export function validateTrustProxyHops(hops: number): void {
  if (!Number.isInteger(hops) || hops < 0 || hops > 32) {
    throw new Error('TRUST_PROXY must be an integer between 0 and 32');
  }
}

function normalizeIp(address: string): string {
  if (isIP(address) !== 6) return address;
  const canonical = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** 소켓 피어를 첫 신뢰 홉으로 세어 XFF 오른쪽 N번째 주소를 고른다. */
function clientIp(req: IncomingMessage, trustedHops: number): string {
  const remoteAddress = normalizeIp(req.socket.remoteAddress ?? 'unknown');
  if (trustedHops === 0) return remoteAddress;

  const header = req.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header.join(',') : header;
  if (typeof forwarded !== 'string') return remoteAddress;

  const chain = forwarded.split(',').map((address) => address.trim());
  const client = chain[chain.length - trustedHops];
  return client && isIP(client) ? normalizeIp(client) : remoteAddress;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
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

export function createApp(deps: AppDeps): Server {
  const { store, verify } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const trustProxyHops = deps.trustProxyHops ?? 0;
  validateTrustProxyHops(trustProxyHops);
  const issueLimit = new RateLimiter(20, 20);
  const submitLimit = new RateLimiter(10, 10);
  const readLimit = new RateLimiter(120, 120);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const ip = clientIp(req, trustProxyHops);
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
      if (!issueLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
      const runId = randomUUID();
      const seed = randomInt(1, 2 ** 31 - 1);
      store.issueRun(runId, seed, SIM_VERSION, ip, now(), MAX_ISSUED_RUNS_PER_IP);
      return send(res, 201, { runId, seed, simVersion: SIM_VERSION });
    }

    if (method === 'GET' && path === '/api/leaderboard') {
      if (!readLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      const rows = store.leaderboard(SIM_VERSION, limit).map((r, i) => ({
        rank: i + 1,
        runId: r.id,
        name: r.name,
        score: r.score,
        kills: r.kills,
        seconds: Math.floor(r.ticks / TICK_RATE),
        level: r.level,
        won: r.won === 1,
      }));
      return send(res, 200, { entries: rows });
    }

    const m = /^\/api\/runs\/([^/]+)\/(submit|replay)$/.exec(path);
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
          name: run.name,
          score: run.score,
          inputs: JSON.parse(run.inputs),
        });
      }

      if (m[2] === 'submit' && method === 'POST') {
        if (!submitLimit.take(ip, now())) throw new HttpError(429, 'rate_limited');
        return submit(id, (await readJson(req)) as Record<string, unknown>, res);
      }
    }

    throw new HttpError(404, 'not_found');
  }

  async function submit(id: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    // 1) 형식 검증 — 비싼 재실행 전에 싸게 걸러낼 수 있는 것부터.
    const inputs = body?.inputs;
    const ticks = countTicks(inputs, MAX_TICKS + 4096);
    const claimedScore = body?.score;
    const claimedSum = body?.checksum;
    if (ticks < 1 || !Number.isInteger(claimedScore) || !Number.isInteger(claimedSum)) {
      throw new HttpError(400, 'invalid_payload');
    }
    const run = store.getRun(id);
    if (!run) throw new HttpError(404, 'run_not_found');
    if (run.sim_version !== SIM_VERSION) throw new HttpError(409, 'version_mismatch');

    // 2) 한 번만 제출 가능 (원자적 선점)
    if (!store.claim(id)) {
      if (run.status === 'rejected' && run.reject_reason === 'abandoned') {
        throw new HttpError(409, 'abandoned');
      }
      throw new HttpError(409, 'already_submitted');
    }

    const reject = (reason: string): never => {
      store.markRejected(id, reason, now());
      log(`reject ${id} ${reason}`);
      throw new HttpError(422, reason);
    };

    // 3) 최소·최대 경과 시간 검사: 너무 빠른 제출과 오래된 발급 판 재사용을 제한한다.
    const elapsed = now() - run.issued_at;
    if (elapsed > MAX_RUN_AGE_MS) reject('expired');
    const minElapsed = (ticks / TICK_RATE) * 1000 * 0.9 - 2000;
    if (elapsed < minElapsed) reject('too_fast');

    // 4) 서버 재실행
    let result;
    try {
      result = await verify(run.seed, inputs as number[]);
    } catch (err) {
      if (err instanceof QueueFullError) {
        store.releaseClaim(id);
        throw new HttpError(503, 'server_busy');
      }
      if (err instanceof VerifyError) {
        store.releaseClaim(id);
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
        inputs: JSON.stringify(inputs),
      },
      now(),
    );
    log(`verified ${id} score=${result.score} ticks=${result.ticks}`);
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
      if (err instanceof HttpError) return send(res, err.status, { error: err.code });
      log(`error ${String(err)}`);
      send(res, 500, { error: 'internal' });
    });
  });

  // 주기 정리: 오래된 판과 프로세스 중단으로 남은 검증 작업, 한가한 속도 제한 버킷
  const timer = setInterval(() => {
    const current = now();
    store.purgeStale(current - 2 * 60 * 60 * 1000, current);
    for (const l of [issueLimit, submitLimit, readLimit]) l.sweep(now());
  }, 10 * 60 * 1000);
  timer.unref();
  server.on('close', () => clearInterval(timer));

  return server;
}

// 서버 API 클라이언트. 서버가 없어도(정적 호스팅) 게임은 돌아가야 하므로
// 모든 호출은 실패 시 null/오류 결과를 돌려주고, 호출한 쪽이 오프라인 모드로 처리한다.
// 세션은 서버가 심는 HttpOnly 쿠키 하나다. 스크립트가 읽거나 보낼 수 있는 토큰은 없다.

import { WEB_SIM_VERSION } from '../../shared/defs.ts';

export interface IssuedRun {
  runId: string;
  seed: number;
  simVersion: number;
  segmentFrames: number;
}

/** 발급 결과. quota는 서버는 응답했지만 한도에 걸려 랭킹 판을 받지 못한 경우다. */
export type IssueOutcome =
  | { kind: 'ok'; run: IssuedRun }
  | { kind: 'quota'; error: string; retryAfterMs: number }
  | { kind: 'offline' };

export interface BoardEntry {
  rank: number;
  runId: string;
  name: string;
  score: number;
  kills: number;
  seconds: number;
  level: number;
  won: boolean;
}

export interface SubmitOk {
  ok: true;
  name: string;
  score: number;
  rank: number;
}

export interface ReplayData {
  seed: number;
  simVersion: number;
  /** v3: 구간 1, 2, ...의 시드. v2는 빈 배열. */
  segmentSeeds: number[];
  name: string;
  score: number;
  inputs: number[];
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 4000): Promise<{ status: number; data: T } | null> {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    return { status: res.status, data: (await res.json()) as T };
  } catch {
    return null;
  }
}

export async function issueRun(): Promise<IssueOutcome> {
  const r = await call<IssuedRun & { error?: string; retryAfterMs?: number }>('POST', `/api/runs?version=${WEB_SIM_VERSION}`, undefined, 2000);
  if (!r) return { kind: 'offline' };
  if (r.status === 201) return { kind: 'ok', run: r.data };
  if (r.status === 429 || r.status === 503) {
    return { kind: 'quota', error: r.data.error ?? 'unknown', retryAfterMs: r.data.retryAfterMs ?? 0 };
  }
  return { kind: 'offline' };
}

export async function fetchBoard(): Promise<BoardEntry[] | null> {
  const r = await call<{ entries: BoardEntry[] }>('GET', `/api/leaderboard?limit=10&version=${WEB_SIM_VERSION}`);
  return r && r.status === 200 ? r.data.entries : null;
}

export async function fetchReplay(runId: string): Promise<ReplayData | null> {
  const r = await call<ReplayData>('GET', `/api/runs/${runId}/replay`);
  return r && r.status === 200 ? r.data : null;
}


/** 검증이 진행 중일 때(`already_submitted`) 같은 제출을 잠시 더 보내 보는 전체 시간과 간격. */
const SUBMIT_POLL_MS = 12_000;
const SUBMIT_POLL_INTERVAL_MS = 1000;

/** 판이 끝나면 전체 입력을 한 번에 제출한다. 같은 페이로드로 재시도할 수 있다. */
export async function submitRun(
  runId: string,
  payload: { name: string; score: number; checksum: number; inputs: readonly number[] },
): Promise<SubmitOk | { ok: false; error: string }> {
  const deadline = performance.now() + SUBMIT_POLL_MS;
  for (;;) {
    const r = await call<SubmitOk & { error?: string }>('POST', `/api/runs/${runId}/submit`, payload, 15000);
    if (!r) return { ok: false, error: 'network' };
    if (r.status === 200) return r.data;
    const error = r.data.error ?? 'unknown';
    if (error !== 'already_submitted' || deadline - performance.now() <= SUBMIT_POLL_INTERVAL_MS) return { ok: false, error };
    await new Promise((resolve) => setTimeout(resolve, SUBMIT_POLL_INTERVAL_MS));
  }
}

// 서버 API 클라이언트. 서버가 없어도(정적 호스팅) 게임은 돌아가야 하므로
// 모든 호출은 실패 시 null/오류 결과를 돌려주고, 호출한 쪽이 오프라인 모드로 처리한다.
// 세션은 서버가 심는 HttpOnly 쿠키 하나다. 스크립트가 읽거나 보낼 수 있는 토큰은 없다.

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

export type SegmentResult =
  | { ok: true; final: boolean; next: { index: number; seed: number } | null }
  | { ok: false; error: string };

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
  const r = await call<IssuedRun & { error?: string; retryAfterMs?: number }>('POST', '/api/runs', undefined, 2000);
  if (!r) return { kind: 'offline' };
  if (r.status === 201) return { kind: 'ok', run: r.data };
  if (r.status === 429 || r.status === 503) {
    return { kind: 'quota', error: r.data.error ?? 'unknown', retryAfterMs: r.data.retryAfterMs ?? 0 };
  }
  return { kind: 'offline' };
}

export async function fetchBoard(): Promise<BoardEntry[] | null> {
  const r = await call<{ entries: BoardEntry[] }>('GET', '/api/leaderboard?limit=10');
  return r && r.status === 200 ? r.data.entries : null;
}

export async function fetchReplay(runId: string): Promise<ReplayData | null> {
  const r = await call<ReplayData>('GET', `/api/runs/${runId}/replay`);
  return r && r.status === 200 ? r.data : null;
}

/** 구간 전송 한 번에 쓸 수 있는 전체 시간(재시도 포함). 이 시간이 지나면 서버 없이 로컬로 이어간다. */
export const SEGMENT_DEADLINE_MS = 6000;
const SEGMENT_ATTEMPT_MS = 3000;

/**
 * 구간 입력을 서버에 확정하고 다음 구간 시드를 받는다. 같은 입력의 재전송은 서버가 같은 응답을 돌려주므로
 * 네트워크 오류·시간 초과·서버 5xx·너무 이른 요청(425)만 deadline 안에서 다시 보낸다.
 * 그 밖의 오류(만료, 무효화, 충돌 등)는 다시 보내도 같은 결과이므로 곧바로 돌려준다.
 */
export async function commitSegment(
  runId: string,
  index: number,
  runs: number[],
  final: boolean,
  deadlineMs = SEGMENT_DEADLINE_MS,
): Promise<SegmentResult> {
  const deadline = performance.now() + deadlineMs;
  let lastError = 'network';
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { ok: false, error: lastError };
    const r = await call<{ final?: boolean; next?: { index: number; seed: number } | null; error?: string; retryAfterMs?: number }>(
      'POST',
      `/api/runs/${runId}/segments/${index}`,
      { inputs: runs, final },
      Math.min(SEGMENT_ATTEMPT_MS, remaining),
    );
    if (r && r.status === 200) return { ok: true, final: r.data.final === true, next: r.data.next ?? null };
    if (r && r.status < 500 && r.status !== 425) return { ok: false, error: r.data.error ?? 'unknown' };
    lastError = r ? (r.data.error ?? 'server_busy') : 'network';
    const wait = r?.status === 425 ? Math.min(r.data.retryAfterMs ?? 500, 2000) : 300;
    if (deadline - performance.now() <= wait) return { ok: false, error: lastError };
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** 최종 제출 재시도 사이에 유지하는 상태. 마지막 구간을 서버가 받았다는 확인(ACK)을 기억한다. */
export interface FinalSubmitState {
  finalCommitted: boolean;
}

/** 검증이 진행 중일 때(`already_submitted`) 같은 제출을 잠시 더 보내 보는 전체 시간과 간격. */
const SUBMIT_POLL_MS = 12_000;
const SUBMIT_POLL_INTERVAL_MS = 1000;

/**
 * 판 끝: 마지막 구간을 확정한 뒤 점수·체크섬을 제출한다. 서버는 저장한 입력으로만 검증한다.
 * 같은 `state` 객체와 인자로 다시 부르면 안전하다.
 *  - 마지막 구간 ACK를 받았으면 이후 재시도에서는 구간을 다시 보내지 않는다.
 *  - ACK가 유실돼 구간을 다시 보냈는데 판이 이미 제출·검증 단계(`already_submitted`)면 구간은 이미 받은 것이므로 제출로 넘어간다.
 *  - 이미 검증된 같은 점수·체크섬의 제출은 서버가 같은 성공 응답을 다시 준다.
 *  - 다른 요청이 검증 중이라 `already_submitted`가 오면 짧게 간격을 두고 같은 제출을 다시 보내 결과를 회수한다.
 */
export async function submitRun(
  runId: string,
  finalSegment: { index: number; runs: number[] },
  payload: { name: string; score: number; checksum: number },
  state: FinalSubmitState = { finalCommitted: false },
): Promise<SubmitOk | { ok: false; error: string }> {
  if (!state.finalCommitted) {
    const committed = await commitSegment(runId, finalSegment.index, finalSegment.runs, true, 15000);
    if (!committed.ok && committed.error !== 'already_submitted') return committed;
    state.finalCommitted = true;
  }
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

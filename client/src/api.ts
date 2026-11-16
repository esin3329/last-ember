// 서버 API 클라이언트. 서버가 없어도(정적 호스팅) 게임은 돌아가야 하므로
// 모든 호출은 실패 시 null을 돌려주고, 호출한 쪽이 오프라인 모드로 처리한다.

export interface IssuedRun {
  runId: string;
  seed: number;
  simVersion: number;
}

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
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    return { status: res.status, data: (await res.json()) as T };
  } catch {
    return null;
  }
}

export async function issueRun(): Promise<IssuedRun | null> {
  const r = await call<IssuedRun>('POST', '/api/runs', undefined, 2000);
  return r && r.status === 201 ? r.data : null;
}

export async function fetchBoard(): Promise<BoardEntry[] | null> {
  const r = await call<{ entries: BoardEntry[] }>('GET', '/api/leaderboard?limit=10');
  return r && r.status === 200 ? r.data.entries : null;
}

export async function fetchReplay(runId: string): Promise<ReplayData | null> {
  const r = await call<ReplayData>('GET', `/api/runs/${runId}/replay`);
  return r && r.status === 200 ? r.data : null;
}

export async function submitRun(
  runId: string,
  payload: { name: string; inputs: number[]; score: number; checksum: number },
): Promise<SubmitOk | { ok: false; error: string }> {
  const r = await call<SubmitOk & { error?: string }>('POST', `/api/runs/${runId}/submit`, payload, 15000);
  if (!r) return { ok: false, error: 'network' };
  if (r.status === 200) return r.data;
  return { ok: false, error: r.data.error ?? 'unknown' };
}

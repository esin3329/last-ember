// 저장소 계층 (node:sqlite). HTTP 계층은 이 클래스의 메서드만 알면 된다.
//
// 상태: issued(구간 입력 수신 중) → sealed(마지막 구간까지 확정, 제출 대기) → verifying → verified | rejected
// 세션·발급 한도·구간 입력이 모두 이 DB에 있어서 프로세스를 다시 띄워도 한도가 초기화되지 않는다.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { WEB_SIM_VERSION } from '../../shared/defs.ts';
import { RANKED_LIMITS, type RankedLimits } from './ranked.ts';

export type RunStatus = 'issued' | 'sealed' | 'verifying' | 'verified' | 'rejected';

export interface RunRow {
  id: string;
  seed: number;
  issued_at: number;
  status: RunStatus;
  reject_reason: string | null;
  name: string | null;
  score: number | null;
  inputs: string | null;
  sim_version: number;
  session_id: string | null;
  secret: Uint8Array | null;
  /** 확정된 구간 수(마지막 구간 포함). */
  committed: number;
  /** 확정된 입력 프레임 합계. */
  frames: number;
  last_activity: number | null;
  /** 현재 구간 시드를 공개한 시각. 구간 최소 소요 시간의 기준. */
  seg_at: number | null;
  /** 검증 완료 판의 공개된 구간 시드(JSON 배열, 1번 구간부터). */
  seg_seeds: string | null;
  kills: number | null;
  won: number | null;
  /** 검증 완료 판이 제출 때 주장한 체크섬(구 DB의 판은 null). */
  checksum: number | null;
}

export interface LeaderboardRow {
  id: string;
  name: string;
  score: number;
  kills: number;
  ticks: number;
  level: number;
  won: number;
  submitted_at: number;
}

export interface VerifiedRun {
  name: string;
  score: number;
  kills: number;
  ticks: number;
  level: number;
  won: boolean;
  inputs: string;
  segmentSeeds?: string;
  /** 제출 때 주장한 체크섬. 응답이 유실된 같은 제출의 재전송을 알아보는 데 쓴다. */
  checksum?: number;
}

export interface SegmentRow {
  idx: number;
  inputs: string;
  frames: number;
  final: number;
}

export interface IssueInput {
  runId: string;
  seed: number;
  secret: Uint8Array;
  simVersion: number;
  sessionHash: string;
  ip: string;
  now: number;
}

export type IssueError = 'session_quota' | 'ip_quota' | 'ip_open' | 'ip_sessions' | 'busy';
export type IssueResult = { ok: true } | { ok: false; error: IssueError; retryAfterMs: number };

const NEW_COLUMNS: [string, string][] = [
  ['session_id', 'TEXT'],
  ['secret', 'BLOB'],
  ['committed', 'INTEGER NOT NULL DEFAULT 0'],
  ['frames', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_activity', 'INTEGER'],
  ['seg_at', 'INTEGER'],
  ['seg_seeds', 'TEXT'],
  ['checksum', 'INTEGER'],
];

const OPEN = "('issued', 'sealed')";

export class Store {
  private db: DatabaseSync;
  private stmt: Record<string, StatementSync>;
  private limits: RankedLimits;

  constructor(path: string, limits: RankedLimits = RANKED_LIMITS) {
    this.limits = limits;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        seed          INTEGER NOT NULL,
        sim_version   INTEGER NOT NULL,
        ip            TEXT NOT NULL,
        issued_at     INTEGER NOT NULL,
        status        TEXT NOT NULL DEFAULT 'issued',
        name          TEXT,
        score         INTEGER,
        kills         INTEGER,
        ticks         INTEGER,
        level         INTEGER,
        won           INTEGER,
        inputs        TEXT,
        reject_reason TEXT,
        submitted_at  INTEGER
      );
    `);
    // v2 DB에서 올라오면 v3 열을 덧붙인다. 기존 검증 완료 판(리플레이)은 그대로 남는다.
    const have = new Set((this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of NEW_COLUMNS) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        ip         TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_segments (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        idx    INTEGER NOT NULL,
        inputs TEXT NOT NULL,
        frames INTEGER NOT NULL,
        final  INTEGER NOT NULL,
        PRIMARY KEY (run_id, idx)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_runs_board ON runs (sim_version, status, score DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_stale ON runs (status, issued_at);
      CREATE INDEX IF NOT EXISTS idx_runs_issue_ip ON runs (ip, status, issued_at);
      CREATE INDEX IF NOT EXISTS idx_runs_ip_issued ON runs (ip, issued_at);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id, issued_at);
      CREATE INDEX IF NOT EXISTS idx_runs_issued_at ON runs (issued_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_ip ON sessions (ip, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_seen ON sessions (last_seen);
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.stmt = {
      // 같은 세션의 미제출 판 중 최근 N개를 뺀 나머지를 폐기한다. 폐기분도 발급 이력(행)에 남는다.
      abandonSegments: p(`DELETE FROM run_segments WHERE run_id IN (
                            SELECT id FROM runs
                            WHERE session_id = ? AND status IN ${OPEN}
                              AND id NOT IN (
                                SELECT id FROM runs
                                WHERE session_id = ? AND status IN ${OPEN}
                                ORDER BY issued_at DESC, rowid DESC LIMIT ?
                              ))`),
      abandonExcess: p(`UPDATE runs SET status = 'rejected', reject_reason = 'abandoned', submitted_at = ?
                         WHERE session_id = ? AND status IN ${OPEN}
                           AND id NOT IN (
                             SELECT id FROM runs
                             WHERE session_id = ? AND status IN ${OPEN}
                             ORDER BY issued_at DESC, rowid DESC LIMIT ?
                           )`),
      create: p(`INSERT INTO runs (id, seed, sim_version, ip, issued_at, session_id, secret, last_activity, seg_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      get: p(`SELECT id, seed, issued_at, status, name, score, kills, won, checksum, inputs, sim_version, reject_reason,
                     session_id, secret, committed, frames, last_activity, seg_at, seg_seeds
              FROM runs WHERE id = ?`),
      getSession: p('SELECT id, last_seen FROM sessions WHERE id = ?'),
      touchSession: p('UPDATE sessions SET last_seen = ? WHERE id = ?'),
      createSession: p('INSERT INTO sessions (id, ip, created_at, last_seen) VALUES (?, ?, ?, ?)'),
      countSessions: p('SELECT COUNT(*) AS n FROM sessions'),
      ipSessions: p('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM sessions WHERE ip = ? AND created_at > ?'),
      openRuns: p(`SELECT COUNT(*) AS n FROM runs WHERE status IN ${OPEN}`),
      windowRuns: p('SELECT COUNT(*) AS n FROM runs WHERE issued_at > ?'),
      ipWindowRuns: p('SELECT COUNT(*) AS n, MIN(issued_at) AS oldest FROM runs WHERE ip = ? AND issued_at > ?'),
      ipOpenRuns: p(`SELECT COUNT(*) AS n FROM runs WHERE ip = ? AND status IN ${OPEN}`),
      sessionWindowRuns: p('SELECT COUNT(*) AS n, MIN(issued_at) AS oldest FROM runs WHERE session_id = ? AND issued_at > ?'),
      recoverAll: p(`UPDATE runs SET status = 'rejected', reject_reason = 'interrupted', submitted_at = ?
                      WHERE status = 'verifying'`),
      recoverStale: p(`UPDATE runs SET status = 'rejected', reject_reason = 'interrupted', submitted_at = ?
                        WHERE status = 'verifying' AND issued_at < ?`),
      // 상태 조건을 건 UPDATE로 "한 번만 제출"을 원자적으로 보장한다(중복 제출 경쟁 방지).
      claim: p(`UPDATE runs SET status = 'verifying' WHERE id = ? AND status = 'sealed'`),
      releaseClaim: p(`UPDATE runs SET status = 'sealed', reject_reason = NULL, submitted_at = NULL
                       WHERE id = ? AND status = 'verifying'`),
      verified: p(`UPDATE runs SET status = 'verified', name = ?, score = ?, kills = ?, ticks = ?,
                   level = ?, won = ?, inputs = ?, seg_seeds = ?, checksum = ?, secret = NULL, submitted_at = ? WHERE id = ?`),
      rejected: p(`UPDATE runs SET status = 'rejected', reject_reason = ?, secret = NULL, submitted_at = ? WHERE id = ?`),
      dropSegments: p('DELETE FROM run_segments WHERE run_id = ?'),
      addSegment: p('INSERT INTO run_segments (run_id, idx, inputs, frames, final) VALUES (?, ?, ?, ?, ?)'),
      advance: p(`UPDATE runs SET committed = committed + 1, frames = frames + ?, last_activity = ?, seg_at = ?,
                         status = ?
                  WHERE id = ? AND status = 'issued' AND committed = ?`),
      segments: p('SELECT idx, inputs, frames, final FROM run_segments WHERE run_id = ? ORDER BY idx'),
      segment: p('SELECT idx, inputs, frames, final FROM run_segments WHERE run_id = ? AND idx = ?'),
      rank: p('SELECT COUNT(*) AS n FROM runs WHERE sim_version = ? AND status = \'verified\' AND score > ?'),
      board: p(`SELECT id, name, score, kills, ticks, level, won, submitted_at FROM runs
                WHERE sim_version = ? AND status = 'verified' ORDER BY score DESC, submitted_at ASC LIMIT ?`),
      // 만료: 입력이 끊긴 진행 중 판, 제출 기한이 지난 판. 구간 입력은 바로 지운다.
      expireSegments: p(`DELETE FROM run_segments WHERE run_id IN (
                           SELECT id FROM runs WHERE
                             (status = 'issued' AND ((sim_version != ${WEB_SIM_VERSION} AND COALESCE(last_activity, issued_at) < ?) OR issued_at < ?)) OR
                             (status = 'sealed' AND issued_at < ?))`),
      expire: p(`UPDATE runs SET status = 'rejected', reject_reason = 'expired', secret = NULL, submitted_at = ? WHERE
                   (status = 'issued' AND ((sim_version != ${WEB_SIM_VERSION} AND COALESCE(last_activity, issued_at) < ?) OR issued_at < ?)) OR
                   (status = 'sealed' AND issued_at < ?)`),
      purge: p(`DELETE FROM runs WHERE
                 (status IN ${OPEN} AND issued_at < ?) OR
                 (status = 'rejected' AND COALESCE(submitted_at, issued_at) < ?)`),
      purgeSessions: p('DELETE FROM sessions WHERE last_seen < ?'),
      trim: p(`DELETE FROM runs WHERE sim_version = ? AND status = 'verified' AND id NOT IN (
                 SELECT id FROM runs WHERE sim_version = ? AND status = 'verified'
                 ORDER BY score DESC, submitted_at ASC, rowid ASC LIMIT ?)`),
    };
    // DB 파일당 하나의 서버만 사용한다. 다른 서버의 진행 중 검증과 중단된 작업은 구별하지 않는다.
    // 프로세스 재시작으로 남은 검증 작업은 다시 제출할 수 없도록 회수한다.
    this.stmt.recoverAll.run(Date.now());
  }

  get isClosed(): boolean {
    return !this.db.isOpen;
  }

  private count(name: string, ...args: (string | number)[]): { n: number; oldest: number | null } {
    const row = this.stmt[name].get(...args) as { n: number; oldest?: number | null };
    return { n: Number(row.n), oldest: row.oldest === undefined || row.oldest === null ? null : Number(row.oldest) };
  }

  /**
   * 세션·IP·전체 한도를 확인하고 판을 발급한다. 한도를 넘기면 아무것도 쓰지 않고 이유를 돌려준다.
   * 한 트랜잭션이라 세션 생성과 발급이 같이 성공하거나 같이 취소된다.
   */
  issueRun(input: IssueInput): IssueResult {
    this.db.exec('BEGIN IMMEDIATE');
    let result: IssueResult;
    try {
      result = this.admit(input);
      this.db.exec(result.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (err) {
      try {
        // SQLITE_FULL/IOERR 등은 SQLite 자체가 이미 트랜잭션을 취소했을 수 있다.
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        // 미완료 트랜잭션에서 다른 요청이 읽거나 쓰지 못하게 연결을 폐쇄한다.
        this.close();
        throw new AggregateError([err, rollbackError], 'Failed to roll back run issuance');
      }
      throw err;
    }
    return result;
  }

  private admit(i: IssueInput): IssueResult {
    const L = this.limits;
    const since = i.now - L.windowMs;
    const wait = (oldest: number | null): number => (oldest === null ? L.windowMs : Math.max(1, oldest + L.windowMs - i.now));
    this.expireOpen(i.now);

    const session = this.stmt.getSession.get(i.sessionHash) as { last_seen: number } | undefined;
    if (!session) {
      const mine = this.count('ipSessions', i.ip, since);
      if (mine.n >= L.ipNewSessions) return { ok: false, error: 'ip_sessions', retryAfterMs: wait(mine.oldest) };
      if (this.count('countSessions').n >= L.maxSessions) return { ok: false, error: 'busy', retryAfterMs: L.windowMs };
      this.stmt.createSession.run(i.sessionHash, i.ip, i.now, i.now);
    } else if (session.last_seen < i.now - 60_000) {
      this.stmt.touchSession.run(i.now, i.sessionHash);
    }

    if (this.count('openRuns').n >= L.maxOpenRuns) return { ok: false, error: 'busy', retryAfterMs: L.idleMs };
    if (this.count('windowRuns', since).n >= L.maxWindowRuns) return { ok: false, error: 'busy', retryAfterMs: L.windowMs };

    const ip = this.count('ipWindowRuns', i.ip, since);
    if (ip.n >= L.ipWindow) return { ok: false, error: 'ip_quota', retryAfterMs: wait(ip.oldest) };
    if (this.count('ipOpenRuns', i.ip).n >= L.ipOpen) return { ok: false, error: 'ip_open', retryAfterMs: L.idleMs };

    const mine = this.count('sessionWindowRuns', i.sessionHash, since);
    if (mine.n >= L.sessionWindow) return { ok: false, error: 'session_quota', retryAfterMs: wait(mine.oldest) };

    this.stmt.abandonSegments.run(i.sessionHash, i.sessionHash, L.sessionOpen - 1);
    this.stmt.abandonExcess.run(i.now, i.sessionHash, i.sessionHash, L.sessionOpen - 1);
    this.stmt.create.run(i.runId, i.seed, i.simVersion, i.ip, i.now, i.sessionHash, i.secret, i.now, i.now);
    return { ok: true };
  }

  hasSession(sessionHash: string): boolean {
    return this.stmt.getSession.get(sessionHash) !== undefined;
  }

  getRun(id: string): RunRow | undefined {
    return this.stmt.get.get(id) as unknown as RunRow | undefined;
  }

  /**
   * 구간 입력을 확정하고 다음 구간 시드 공개 시각을 기록한다. 마지막 구간이면 판을 sealed로 바꾼다.
   * 이미 확정된 구간이거나 판 상태가 바뀌었으면 false(아무것도 쓰지 않음).
   */
  appendSegment(id: string, idx: number, inputs: string, frames: number, final: boolean, now: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const moved = Number(this.stmt.advance.run(frames, now, now, final ? 'sealed' : 'issued', id, idx).changes) === 1;
      if (moved) this.stmt.addSegment.run(id, idx, inputs, frames, final ? 1 : 0);
      this.db.exec(moved ? 'COMMIT' : 'ROLLBACK');
      return moved;
    } catch (err) {
      try {
        if (this.db.isTransaction) this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        this.close();
        throw new AggregateError([err, rollbackError], 'Failed to roll back segment commit');
      }
      throw err;
    }
  }

  getSegment(id: string, idx: number): SegmentRow | undefined {
    return this.stmt.segment.get(id, idx) as unknown as SegmentRow | undefined;
  }

  getSegments(id: string): SegmentRow[] {
    return this.stmt.segments.all(id) as unknown as SegmentRow[];
  }

  /** 제출 권한을 선점한다. 마지막 구간까지 확정(sealed)된 판만 가능하고, 이미 제출됐으면 false. */
  claim(id: string): boolean {
    return Number(this.stmt.claim.run(id).changes) === 1;
  }

  /** 검증 장애로 실패한 제출 권한을 되돌린다. */
  releaseClaim(id: string): void {
    this.stmt.releaseClaim.run(id);
  }

  markVerified(id: string, r: VerifiedRun, now: number): void {
    this.stmt.verified.run(r.name, r.score, r.kills, r.ticks, r.level, r.won ? 1 : 0, r.inputs, r.segmentSeeds ?? null, r.checksum ?? null, now, id);
    this.stmt.dropSegments.run(id);
  }

  markRejected(id: string, reason: string, now: number): void {
    this.stmt.rejected.run(reason, now, id);
    this.stmt.dropSegments.run(id);
  }

  leaderboard(simVersion: number, limit: number): LeaderboardRow[] {
    return this.stmt.board.all(simVersion, limit) as unknown as LeaderboardRow[];
  }

  rankOf(simVersion: number, score: number): number {
    return Number((this.stmt.rank.get(simVersion, score) as { n: number }).n) + 1;
  }

  /** 입력이 끊겼거나 제출 기한이 지난 열린 판을 만료시켜 한도 슬롯과 구간 저장 공간을 돌려받는다. */
  expireOpen(now: number): number {
    const idleBefore = now - this.limits.idleMs;
    const ageBefore = now - this.limits.maxRunAgeMs;
    this.stmt.expireSegments.run(idleBefore, ageBefore, ageBefore);
    return Number(this.stmt.expire.run(now, idleBefore, ageBefore, ageBefore).changes);
  }

  purgeStale(before: number, now = Date.now()): number {
    this.stmt.recoverStale.run(now, before);
    return Number(this.stmt.purge.run(before, before).changes);
  }

  purgeSessions(before: number): number {
    return Number(this.stmt.purgeSessions.run(before).changes);
  }

  /** 현재 규칙의 검증 완료 기록을 상위 keep개만 남긴다. 구 규칙(v2) 기록은 늘어나지 않으므로 건드리지 않는다. */
  trimBoard(simVersion: number, keep: number): number {
    return Number(this.stmt.trim.run(simVersion, simVersion, keep).changes);
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

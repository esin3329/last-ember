// 저장소 계층 (node:sqlite). HTTP 계층은 이 클래스의 메서드만 알면 된다.

import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type RunStatus = 'issued' | 'verifying' | 'verified' | 'rejected';

export interface RunRow {
  id: string;
  seed: number;
  issued_at: number;
  status: RunStatus;
  name: string | null;
  score: number | null;
  inputs: string | null;
  sim_version: number;
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
}

export class Store {
  private db: DatabaseSync;
  private stmt: Record<string, StatementSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
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
      CREATE INDEX IF NOT EXISTS idx_runs_board ON runs (sim_version, status, score DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_stale ON runs (status, issued_at);
      CREATE INDEX IF NOT EXISTS idx_runs_issue_ip ON runs (ip, status, issued_at);
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.stmt = {
      abandonExcess: p(`UPDATE runs SET status = 'rejected', reject_reason = 'abandoned', submitted_at = ?
                         WHERE ip = ? AND status = 'issued'
                           AND id NOT IN (
                             SELECT id FROM runs
                             WHERE ip = ? AND status = 'issued'
                             ORDER BY issued_at DESC, rowid DESC LIMIT ?
                           )`),
      create: p('INSERT INTO runs (id, seed, sim_version, ip, issued_at) VALUES (?, ?, ?, ?, ?)'),
      get: p('SELECT id, seed, issued_at, status, name, score, inputs, sim_version FROM runs WHERE id = ?'),
      // 상태 조건을 건 UPDATE로 "한 번만 제출"을 원자적으로 보장한다(중복 제출 경쟁 방지).
      claim: p(`UPDATE runs SET status = 'verifying' WHERE id = ? AND status = 'issued'`),
      verified: p(`UPDATE runs SET status = 'verified', name = ?, score = ?, kills = ?, ticks = ?,
                   level = ?, won = ?, inputs = ?, submitted_at = ? WHERE id = ?`),
      rejected: p(`UPDATE runs SET status = 'rejected', reject_reason = ?, submitted_at = ? WHERE id = ?`),
      board: p(`SELECT id, name, score, kills, ticks, level, won, submitted_at FROM runs
                WHERE sim_version = ? AND status = 'verified' ORDER BY score DESC, submitted_at ASC LIMIT ?`),
      rank: p(`SELECT COUNT(*) AS n FROM runs WHERE sim_version = ? AND status = 'verified' AND score > ?`),
      purge: p(`DELETE FROM runs WHERE status IN ('issued', 'rejected') AND issued_at < ?`),
    };
  }

  /** IP당 열린 판을 제한하고, 상한을 넘기는 가장 오래된 판부터 무효화한다. */
  issueRun(id: string, seed: number, simVersion: number, ip: string, now: number, maxOpen: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.stmt.abandonExcess.run(now, ip, ip, maxOpen - 1);
      this.stmt.create.run(id, seed, simVersion, ip, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getRun(id: string): RunRow | undefined {
    return this.stmt.get.get(id) as unknown as RunRow | undefined;
  }

  /** 제출 권한을 선점한다. 이미 제출됐거나 없는 판이면 false. */
  claim(id: string): boolean {
    return Number(this.stmt.claim.run(id).changes) === 1;
  }

  markVerified(id: string, r: VerifiedRun, now: number): void {
    this.stmt.verified.run(r.name, r.score, r.kills, r.ticks, r.level, r.won ? 1 : 0, r.inputs, now, id);
  }

  markRejected(id: string, reason: string, now: number): void {
    this.stmt.rejected.run(reason, now, id);
  }

  leaderboard(simVersion: number, limit: number): LeaderboardRow[] {
    return this.stmt.board.all(simVersion, limit) as unknown as LeaderboardRow[];
  }

  rankOf(simVersion: number, score: number): number {
    return Number((this.stmt.rank.get(simVersion, score) as { n: number }).n) + 1;
  }

  purgeStale(before: number): number {
    return Number(this.stmt.purge.run(before).changes);
  }

  close(): void {
    this.db.close();
  }
}

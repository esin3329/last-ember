// SQLite 저장소의 발급 원자성·한도·구간 입력·프로세스 재시작·주기 정리 테스트.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RANKED_LIMITS, RUN_RETENTION_MS, type RankedLimits } from '../src/ranked.ts';
import { Store, type IssueResult, type VerifiedRun } from '../src/store.ts';

const verifiedRun: VerifiedRun = {
  name: 'player',
  score: 100,
  kills: 10,
  ticks: 1000,
  level: 2,
  won: false,
  inputs: '[4,1000]',
};

/** 한도를 거의 끄고 시험할 항목만 켠다. */
function limits(over: Partial<RankedLimits> = {}): RankedLimits {
  return {
    ...RANKED_LIMITS,
    sessionWindow: 1000,
    ipWindow: 1000,
    ipOpen: 1000,
    ipNewSessions: 1000,
    maxSessions: 1_000_000,
    maxOpenRuns: 1_000_000,
    maxWindowRuns: 1_000_000,
    ...over,
  };
}

interface IssueOptions {
  ip?: string;
  now?: number;
  session?: string;
}

function tryIssue(store: Store, id: string, o: IssueOptions = {}): IssueResult {
  return store.issueRun({
    runId: id,
    seed: 1,
    secret: new Uint8Array(32).fill(7),
    simVersion: 3,
    sessionHash: o.session ?? 'session-1',
    ip: o.ip ?? '127.0.0.1',
    now: o.now ?? 100,
  });
}

function issue(store: Store, id: string, o: IssueOptions = {}): void {
  const result = tryIssue(store, id, o);
  assert.deepEqual(result, { ok: true }, id);
}

/** 마지막 구간까지 확정된 상태(제출 대기)로 만든다. */
function seal(store: Store, id: string): void {
  const db = Reflect.get(store, 'db') as DatabaseSync;
  db.prepare("UPDATE runs SET status = 'sealed' WHERE id = ? AND status = 'issued'").run(id);
}

function dbOf(store: Store): DatabaseSync {
  return Reflect.get(store, 'db') as DatabaseSync;
}

function count(store: Store, table: string): number {
  return Number((dbOf(store).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

test('같은 issued_at에서는 rowid 순서로 정확히 최근 세 판만 남긴다', () => {
  const store = new Store(':memory:', limits({ sessionOpen: 3 }));
  try {
    issue(store, 'verifying');
    seal(store, 'verifying');
    store.claim('verifying');
    issue(store, 'verified');
    seal(store, 'verified');
    store.claim('verified');
    store.markVerified('verified', verifiedRun, 150);
    issue(store, 'rejected');
    seal(store, 'rejected');
    store.claim('rejected');
    store.markRejected('rejected', 'mismatch', 150);
    issue(store, 'other-session', { session: 'session-2' });

    // ID 사전순과 반대로 발급해서 동일 시각의 삽입 순서까지 확인한다.
    const ids = ['z', 'y', 'x', 'w', 'v', 'u'];
    for (const [index, id] of ids.entries()) {
      issue(store, id);
      for (let i = 0; i <= index; i++) {
        const run = store.getRun(ids[i]);
        const abandoned = i <= index - 3;
        assert.equal(run?.status, abandoned ? 'rejected' : 'issued', ids[i]);
        assert.equal(run?.reject_reason, abandoned ? 'abandoned' : null, ids[i]);
      }
    }
    assert.equal(store.claim('z'), false);

    // 상한을 낮추면 한 번에 여러 판을 회수하며, 최소 상한 1도 정확히 지킨다.
    Reflect.set(store, 'limits', limits({ sessionOpen: 1 }));
    issue(store, 'only-open');
    for (const id of ids) assert.equal(store.getRun(id)?.reject_reason, 'abandoned');
    assert.equal(store.getRun('only-open')?.status, 'issued');
    assert.equal(store.getRun('other-session')?.status, 'issued');
    assert.equal(store.getRun('verifying')?.status, 'verifying');
    assert.equal(store.getRun('verified')?.status, 'verified');
    assert.equal(store.getRun('rejected')?.reject_reason, 'mismatch');
  } finally {
    store.close();
  }
});

test('열린 판을 폐기해도 발급 이력에는 남고, 폐기된 판의 구간 입력은 지워진다', () => {
  const store = new Store(':memory:', limits({ sessionOpen: 1 }));
  try {
    issue(store, 'first');
    assert.equal(store.appendSegment('first', 0, '[4,600]', 600, false, 110), true);
    assert.equal(store.getSegments('first').length, 1);
    issue(store, 'second', { now: 200 });
    assert.equal(store.getRun('first')?.reject_reason, 'abandoned');
    assert.equal(store.getSegments('first').length, 0);
    assert.equal(count(store, 'runs'), 2);
  } finally {
    store.close();
  }
});

test('INSERT 실패는 앞서 회수한 판까지 되돌리고 다음 발급을 허용한다', () => {
  const store = new Store(':memory:', limits({ sessionOpen: 3 }));
  try {
    for (const [index, id] of ['oldest', 'middle', 'newest'].entries()) {
      issue(store, id, { now: 100 + index });
    }
    assert.throws(() => tryIssue(store, 'middle', { now: 200 }), /UNIQUE constraint failed/);
    for (const id of ['oldest', 'middle', 'newest']) {
      assert.equal(store.getRun(id)?.status, 'issued');
      assert.equal(store.getRun(id)?.reject_reason, null);
    }
    issue(store, 'next', { now: 201 });
    assert.equal(store.getRun('oldest')?.reject_reason, 'abandoned');
    assert.equal(store.getRun('middle')?.status, 'issued');
    assert.equal(store.getRun('newest')?.status, 'issued');
    assert.equal(store.getRun('next')?.status, 'issued');
  } finally {
    store.close();
  }
});

for (const operation of [
  "UPDATE OF status ON runs WHEN NEW.reject_reason = 'abandoned'",
  "INSERT ON runs WHEN NEW.id = 'next'",
]) {
  test(`SQLite 자체 ROLLBACK의 원래 오류를 보존한다: ${operation}`, () => {
    const store = new Store(':memory:', limits({ sessionOpen: 1 }));
    // 실제 SQLite 트리거로 자동 롤백을 재현한다. 운영 코드에 테스트용 주입 API는 두지 않는다.
    const db = dbOf(store);
    try {
      issue(store, 'oldest');
      db.exec(`CREATE TRIGGER fail_issue BEFORE ${operation}
               BEGIN SELECT RAISE(ROLLBACK, 'automatic rollback'); END`);
      assert.throws(() => tryIssue(store, 'next', { now: 200 }), /automatic rollback/);
      assert.equal(db.isTransaction, false);
      assert.equal(store.getRun('oldest')?.status, 'issued');
      assert.equal(store.getRun('oldest')?.reject_reason, null);
      assert.equal(store.getRun('next'), undefined);

      db.exec('DROP TRIGGER fail_issue');
      issue(store, 'next', { now: 201 });
      assert.equal(store.getRun('oldest')?.reject_reason, 'abandoned');
      assert.equal(store.getRun('next')?.status, 'issued');
    } finally {
      store.close();
    }
  });
}

for (const operation of ['BEGIN IMMEDIATE', 'COMMIT']) {
  test(`${operation} 실패가 부분 발급이나 열린 트랜잭션을 남기지 않는다`, (t) => {
    const store = new Store(':memory:', limits({ sessionOpen: 1 }));
    const db = dbOf(store);
    try {
      issue(store, 'oldest');
      const failure = new Error(`${operation} failed`);
      const exec = db.exec;
      const fault = t.mock.method(db, 'exec', (sql: string) => {
        if (sql === operation) throw failure;
        return exec.call(db, sql);
      });
      assert.throws(() => tryIssue(store, 'next', { now: 200 }), (err) => err === failure);
      assert.equal(db.isTransaction, false);
      assert.equal(store.getRun('oldest')?.status, 'issued');
      assert.equal(store.getRun('oldest')?.reject_reason, null);
      assert.equal(store.getRun('next'), undefined);
      fault.mock.restore();

      issue(store, 'next', { now: 201 });
      assert.equal(store.getRun('oldest')?.reject_reason, 'abandoned');
      assert.equal(store.getRun('next')?.status, 'issued');
    } finally {
      store.close();
    }
  });
}

test('ROLLBACK 자체가 실패하면 연결을 닫아 모든 저장소 작업의 재사용을 막는다', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'last-ember-store-'));
  const path = join(dir, 'runs.db');
  try {
    const store = new Store(path, limits({ sessionOpen: 1 }));
    const db = dbOf(store);
    try {
      issue(store, 'oldest');
      const commitError = new Error('commit failed');
      const rollbackError = new Error('rollback failed');
      const exec = db.exec;
      t.mock.method(db, 'exec', (sql: string) => {
        if (sql === 'COMMIT') throw commitError;
        if (sql === 'ROLLBACK') throw rollbackError;
        return exec.call(db, sql);
      });
      assert.throws(
        () => tryIssue(store, 'next', { now: 200 }),
        (err) => {
          assert.ok(err instanceof AggregateError);
          assert.deepEqual(err.errors, [commitError, rollbackError]);
          return true;
        },
      );
      assert.equal(db.isOpen, false);
      assert.throws(() => tryIssue(store, 'another', { now: 300 }));
      assert.throws(() => store.getRun('oldest'));
      assert.throws(() => store.claim('oldest'));
      assert.throws(() => store.markVerified('oldest', verifiedRun, 300));
      assert.throws(() => store.markRejected('oldest', 'mismatch', 300));
      assert.throws(() => store.leaderboard(1, 10));
      assert.throws(() => store.rankOf(1, 100));
      assert.throws(() => store.purgeStale(200, 300));
      assert.doesNotThrow(() => store.close());
    } finally {
      store.close();
    }

    const reopened = new Store(path, limits({ sessionOpen: 1 }));
    try {
      assert.equal(reopened.getRun('oldest')?.status, 'issued');
      assert.equal(reopened.getRun('oldest')?.reject_reason, null);
      assert.equal(reopened.getRun('next'), undefined);
      issue(reopened, 'next', { now: 300 });
      assert.equal(reopened.getRun('next')?.status, 'issued');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('재시작 시 verifying 판을 rejected(interrupted)로 회수하고 세션·발급 이력은 유지한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-ember-store-'));
  const path = join(dir, 'runs.db');
  try {
    const beforeRestart = new Store(path, limits());
    try {
      issue(beforeRestart, 'interrupted-run');
      seal(beforeRestart, 'interrupted-run');
      assert.equal(beforeRestart.claim('interrupted-run'), true);
      issue(beforeRestart, 'issued');
      issue(beforeRestart, 'verified');
      seal(beforeRestart, 'verified');
      beforeRestart.claim('verified');
      beforeRestart.markVerified('verified', verifiedRun, 150);
      issue(beforeRestart, 'rejected');
      seal(beforeRestart, 'rejected');
      beforeRestart.claim('rejected');
      beforeRestart.markRejected('rejected', 'mismatch', 150);
    } finally {
      beforeRestart.close();
    }

    // 재시작해도 한도는 초기화되지 않는다: 세션 발급 이력(4판)이 한도를 채운다.
    const afterRestart = new Store(path, limits({ sessionWindow: 4 }));
    try {
      const run = afterRestart.getRun('interrupted-run');
      assert.equal(run?.status, 'rejected');
      assert.equal(run?.reject_reason, 'interrupted');
      assert.equal(afterRestart.claim('interrupted-run'), false);
      assert.equal(afterRestart.getRun('issued')?.status, 'issued');
      assert.equal(afterRestart.getRun('verified')?.status, 'verified');
      assert.equal(afterRestart.getRun('verified')?.score, verifiedRun.score);
      assert.equal(afterRestart.getRun('rejected')?.reject_reason, 'mismatch');
      assert.equal(tryIssue(afterRestart, 'over', { now: 200 }).ok, false);
    } finally {
      afterRestart.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('주기 정리는 오래된 verifying 판을 interrupted로 회수한다', () => {
  const store = new Store(':memory:', limits());
  try {
    issue(store, 'stale-verifying-run');
    seal(store, 'stale-verifying-run');
    assert.equal(store.claim('stale-verifying-run'), true);

    store.purgeStale(200, 300);
    const run = store.getRun('stale-verifying-run');
    assert.equal(run?.status, 'rejected');
    assert.equal(run?.reject_reason, 'interrupted');
  } finally {
    store.close();
  }
});

test('정리는 상태별 보존 시각과 엄격한 경계를 지키고 회수 이유를 즉시 지우지 않는다', () => {
  const store = new Store(':memory:', limits({ sessionOpen: 20 }));
  const db = dbOf(store);
  try {
    for (const [id, issuedAt] of [
      ['stale-issued', 100],
      ['boundary-issued', 200],
      ['stale-verifying', 100],
      ['boundary-verifying', 200],
      ['fresh-verifying', 300],
      ['stale-rejected', 100],
      ['boundary-rejected', 100],
      ['fresh-rejected', 100],
      ['legacy-rejected', 100],
      ['verified', 100],
    ] as const) {
      issue(store, id, { now: issuedAt });
    }
    for (const id of ['stale-verifying', 'boundary-verifying', 'fresh-verifying']) {
      seal(store, id);
      store.claim(id);
    }
    for (const [id, rejectedAt] of [
      ['stale-rejected', 199],
      ['boundary-rejected', 200],
      ['fresh-rejected', 250],
    ] as const) {
      seal(store, id);
      store.claim(id);
      store.markRejected(id, 'mismatch', rejectedAt);
    }
    db.exec("UPDATE runs SET status = 'rejected' WHERE id = 'legacy-rejected'");
    seal(store, 'verified');
    store.claim('verified');
    store.markVerified('verified', verifiedRun, 150);

    assert.equal(store.purgeStale(200, 300), 3);
    for (const id of ['stale-issued', 'stale-rejected', 'legacy-rejected']) {
      assert.equal(store.getRun(id), undefined, id);
    }
    assert.equal(store.getRun('boundary-issued')?.status, 'issued');
    assert.equal(store.getRun('stale-verifying')?.status, 'rejected');
    assert.equal(store.getRun('stale-verifying')?.reject_reason, 'interrupted');
    assert.equal(store.claim('stale-verifying'), false);
    assert.equal(store.getRun('boundary-verifying')?.status, 'verifying');
    assert.equal(store.getRun('fresh-verifying')?.status, 'verifying');
    assert.equal(store.getRun('boundary-rejected')?.reject_reason, 'mismatch');
    assert.equal(store.getRun('fresh-rejected')?.reject_reason, 'mismatch');
    assert.equal(store.getRun('verified')?.status, 'verified');

    assert.equal(store.purgeStale(300, 400), 3);
    assert.equal(store.getRun('stale-verifying')?.reject_reason, 'interrupted');
    assert.equal(store.getRun('boundary-verifying')?.reject_reason, 'interrupted');
    assert.equal(store.getRun('fresh-verifying')?.status, 'verifying');
    assert.equal(store.purgeStale(301, 500), 1);
    assert.equal(store.getRun('stale-verifying'), undefined);
    assert.equal(store.getRun('boundary-verifying')?.reject_reason, 'interrupted');
    assert.equal(store.getRun('fresh-verifying')?.reject_reason, 'interrupted');
    assert.equal(store.getRun('verified')?.status, 'verified');
  } finally {
    store.close();
  }
});

// ───────────────────────── 한도 ─────────────────────────

test('세션 발급 이력 한도는 폐기·거절·검증 완료 판도 센다', () => {
  const store = new Store(':memory:', limits({ sessionWindow: 4, sessionOpen: 1 }));
  try {
    issue(store, 'a', { now: 1000 }); // 이후 폐기됨
    issue(store, 'b', { now: 2000 }); // 이후 폐기됨
    issue(store, 'c', { now: 3000 });
    seal(store, 'c');
    store.claim('c');
    store.markRejected('c', 'mismatch', 3500);
    issue(store, 'd', { now: 4000 });
    assert.equal(store.getRun('a')?.reject_reason, 'abandoned');

    const blocked = tryIssue(store, 'e', { now: 5000 });
    assert.deepEqual(blocked, { ok: false, error: 'session_quota', retryAfterMs: 1000 + RANKED_LIMITS.windowMs - 5000 });
    assert.equal(store.getRun('e'), undefined);
    // 다른 세션은 영향이 없다.
    issue(store, 'f', { now: 5000, session: 'session-2' });
    // 가장 오래된 판이 창 밖으로 나가면 다시 발급된다(경계는 엄격: 정확히 창 길이만큼 지나야 한다).
    assert.equal(tryIssue(store, 'g', { now: 1000 + RANKED_LIMITS.windowMs - 1 }).ok, false);
    issue(store, 'g', { now: 1000 + RANKED_LIMITS.windowMs });
  } finally {
    store.close();
  }
});

test('IP 보조 한도: 창당 발급 수, 열린 판 수, 새 세션 수', () => {
  const store = new Store(':memory:', limits({ ipWindow: 3, ipOpen: 2, ipNewSessions: 2 }));
  try {
    issue(store, 'a', { session: 's-a', now: 100 });
    issue(store, 'b', { session: 's-b', now: 100 });
    // 세션을 새로 만드는 요청은 세션 수 한도에 걸린다.
    const sessions = tryIssue(store, 'c', { session: 's-c', now: 100 });
    assert.equal(sessions.ok === false && sessions.error, 'ip_sessions');
    assert.equal(store.hasSession('s-c'), false, '거절된 발급은 세션도 만들지 않는다');
    // 기존 세션이라도 이 IP의 열린 판이 상한(2)이면 거절한다.
    const open = tryIssue(store, 'c', { session: 's-a', now: 100 });
    assert.equal(open.ok === false && open.error, 'ip_open');
    // 열린 판이 줄어도 창당 발급 수(3) 이력은 남는다.
    store.markRejected('a', 'mismatch', 150);
    issue(store, 'd', { session: 's-a', now: 200 });
    store.markRejected('b', 'mismatch', 250);
    const window = tryIssue(store, 'e', { session: 's-b', now: 300 });
    assert.equal(window.ok === false && window.error, 'ip_quota');
    // 다른 IP는 독립이다.
    issue(store, 'other', { session: 's-z', ip: '198.51.100.7', now: 300 });
  } finally {
    store.close();
  }
});

test('전체 상한: 세션 수, 열린 판 수, 창당 발급 수', () => {
  for (const [over, setup] of [
    [{ maxSessions: 1 }, () => 'session-x'],
    [{ maxOpenRuns: 1 }, () => 'session-1'],
    [{ maxWindowRuns: 1 }, () => 'session-1'],
  ] as const) {
    const store = new Store(':memory:', limits(over));
    try {
      issue(store, 'first');
      const result = tryIssue(store, 'second', { session: setup(), ip: '203.0.113.5', now: 200 });
      assert.equal(result.ok === false && result.error, 'busy', JSON.stringify(over));
      assert.equal(store.getRun('second'), undefined);
    } finally {
      store.close();
    }
  }
});

test('발급 이력 보존 기간은 한도 창보다 길어야 한다', () => {
  assert.ok(RUN_RETENTION_MS > RANKED_LIMITS.windowMs);
  assert.ok(RANKED_LIMITS.sessionWindow > RANKED_LIMITS.sessionOpen);
  assert.ok(RANKED_LIMITS.ipOpen >= RANKED_LIMITS.sessionOpen && RANKED_LIMITS.ipWindow >= RANKED_LIMITS.sessionWindow);
});

// ───────────────────────── 구간 입력과 만료 ─────────────────────────

test('구간 입력은 순서대로 한 번씩만 확정되고 마지막 구간이 판을 sealed로 만든다', () => {
  const store = new Store(':memory:', limits());
  try {
    issue(store, 'run');
    assert.equal(store.appendSegment('run', 1, '[4,600]', 600, false, 200), false, '건너뛴 구간');
    assert.equal(store.appendSegment('run', 0, '[4,600]', 600, false, 200), true);
    assert.equal(store.appendSegment('run', 0, '[5,600]', 600, false, 210), false, '같은 구간 덮어쓰기');
    assert.equal(store.getSegment('run', 0)?.inputs, '[4,600]');
    assert.equal(store.appendSegment('run', 1, '[4,30]', 30, true, 300), true);
    const run = store.getRun('run');
    assert.deepEqual([run?.status, run?.committed, run?.frames, run?.seg_at], ['sealed', 2, 630, 300]);
    assert.equal(store.appendSegment('run', 2, '[4,10]', 10, true, 400), false, 'sealed 뒤에는 추가 불가');
    assert.deepEqual(store.getSegments('run').map((s) => [s.idx, s.final]), [[0, 0], [1, 1]]);

    store.markRejected('run', 'mismatch', 500);
    assert.equal(store.getSegments('run').length, 0);
    assert.equal(store.getRun('run')?.secret, null);
  } finally {
    store.close();
  }
});

test('입력이 끊긴 판과 기한이 지난 판은 만료되어 슬롯과 구간 저장 공간을 돌려준다', () => {
  const L = limits();
  const store = new Store(':memory:', limits({ sessionOpen: 10 }));
  try {
    issue(store, 'idle', { now: 1000 });
    store.appendSegment('idle', 0, '[4,600]', 600, false, 2000);
    issue(store, 'active', { now: 1000 + 1 });
    store.appendSegment('active', 0, '[4,600]', 600, false, 1000 + L.idleMs);
    issue(store, 'sealed-old', { now: 1000 + 2 });
    store.appendSegment('sealed-old', 0, '[4,10]', 10, true, 1500);

    // idle: 마지막 입력(2000) 후 idleMs 초과. active: 방금 입력. sealed는 idle 기준이 아니라 발급 기한 기준.
    const now = 2000 + L.idleMs + 1;
    assert.equal(store.expireOpen(now), 1);
    assert.equal(store.getRun('idle')?.reject_reason, 'expired');
    assert.equal(store.getSegments('idle').length, 0);
    assert.equal(store.getRun('active')?.status, 'issued');
    assert.equal(store.getRun('sealed-old')?.status, 'sealed');

    assert.equal(store.expireOpen(1002 + L.maxRunAgeMs + 1), 2);
    assert.equal(store.getRun('sealed-old')?.reject_reason, 'expired');
    assert.equal(store.getSegments('sealed-old').length, 0);
    assert.equal(store.getRun('active')?.reject_reason, 'expired');
    assert.equal(count(store, 'run_segments'), 0);
  } finally {
    store.close();
  }
});

test('발급은 먼저 만료를 반영하므로 끊긴 판이 IP·전체 한도를 계속 차지하지 않는다', () => {
  const L = limits({ ipOpen: 1, maxOpenRuns: 1 });
  const store = new Store(':memory:', L);
  try {
    issue(store, 'zombie', { now: 100 });
    assert.equal(tryIssue(store, 'blocked', { session: 's-2', now: 200 }).ok, false);
    issue(store, 'fresh', { session: 's-2', now: 100 + L.idleMs + 1 });
    assert.equal(store.getRun('zombie')?.reject_reason, 'expired');
  } finally {
    store.close();
  }
});

test('주기 정리는 run을 지울 때 구간 입력도, 오래된 세션도 함께 지운다', () => {
  const store = new Store(':memory:', limits());
  try {
    issue(store, 'gone', { now: 100 });
    store.appendSegment('gone', 0, '[4,600]', 600, false, 110);
    issue(store, 'rejected-gone', { now: 100, session: 'old-session' });
    store.markRejected('rejected-gone', 'mismatch', 150);
    assert.equal(count(store, 'run_segments'), 1);
    assert.equal(store.purgeStale(1000, 2000), 2);
    assert.equal(count(store, 'runs'), 0);
    assert.equal(count(store, 'run_segments'), 0);

    assert.equal(count(store, 'sessions'), 2);
    assert.equal(store.purgeSessions(50), 0);
    assert.equal(store.purgeSessions(101), 2);
    assert.equal(store.hasSession('session-1'), false);
  } finally {
    store.close();
  }
});

test('랭킹 보관 상한: 현재 규칙의 검증 기록은 상위 N개만 남기고 구 규칙 기록은 건드리지 않는다', () => {
  const store = new Store(':memory:', limits({ sessionOpen: 100 }));
  const db = dbOf(store);
  try {
    for (let i = 0; i < 6; i++) {
      issue(store, `run-${i}`, { now: 100 + i });
      seal(store, `run-${i}`);
      store.claim(`run-${i}`);
      store.markVerified(`run-${i}`, { ...verifiedRun, score: i * 10 }, 200 + i);
    }
    db.prepare(
      `INSERT INTO runs (id, seed, sim_version, ip, issued_at, status, score, inputs) VALUES ('legacy', 1, 2, 'x', 1, 'verified', 1, '[]')`,
    ).run();
    // 3점 이하는 라이브 상위 3개 밖
    assert.equal(store.trimBoard(3, 3), 3);
    assert.deepEqual(store.leaderboard(3, 10).map((r) => r.id), ['run-5', 'run-4', 'run-3']);
    assert.equal(store.getRun('legacy')?.status, 'verified');
    assert.equal(store.trimBoard(3, 3), 0);
  } finally {
    store.close();
  }
});

test('v2 DB(세션·구간 열이 없는 runs)를 열면 열을 덧붙이고 기존 검증 기록을 그대로 읽는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-ember-store-'));
  const path = join(dir, 'runs.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, seed INTEGER NOT NULL, sim_version INTEGER NOT NULL, ip TEXT NOT NULL,
        issued_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued', name TEXT, score INTEGER,
        kills INTEGER, ticks INTEGER, level INTEGER, won INTEGER, inputs TEXT, reject_reason TEXT, submitted_at INTEGER
      );
      INSERT INTO runs (id, seed, sim_version, ip, issued_at, status, name, score, kills, ticks, level, won, inputs, submitted_at)
        VALUES ('v2-verified', 7919, 2, '127.0.0.1', 1, 'verified', '옛', 500, 5, 900, 3, 0, '[4,900]', 2);
      INSERT INTO runs (id, seed, sim_version, ip, issued_at) VALUES ('v2-open', 1, 2, '127.0.0.1', 1);
    `);
    old.close();

    const store = new Store(path, limits());
    try {
      const run = store.getRun('v2-verified');
      assert.equal(run?.status, 'verified');
      assert.equal(run?.sim_version, 2);
      assert.equal(run?.inputs, '[4,900]');
      assert.equal(run?.seg_seeds, null);
      assert.equal(run?.committed, 0);
      assert.deepEqual(store.leaderboard(2, 10).map((r) => r.id), ['v2-verified']);
      // 세션이 없는 구 판은 어떤 세션도 소유하지 않고, 새 발급은 정상 동작한다.
      assert.equal(store.getRun('v2-open')?.session_id, null);
      issue(store, 'v3', { now: 5000 });
      // 두 번째 열기도 열 덧붙이기를 반복하지 않는다.
    } finally {
      store.close();
    }
    const again = new Store(path, limits());
    assert.equal(again.getRun('v3')?.status, 'issued');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('검증 장애로 되돌린 판은 상한을 일시적으로 넘길 수 있지만 다음 발급에서 최근 세 판으로 정리된다', () => {
  const store = new Store(':memory:', limits({ sessionOpen: 3 }));
  try {
    issue(store, 'old', { now: 100 });
    seal(store, 'old');
    assert.equal(store.claim('old'), true); // 검증 중에는 열린 판으로 세지 않는다
    for (const [i, id] of ['a', 'b', 'c'].entries()) issue(store, id, { now: 200 + i });
    assert.equal(store.getRun('old')?.status, 'verifying');

    store.releaseClaim('old'); // 검증 장애: 같은 판을 다시 제출할 수 있도록 sealed로 복구
    assert.equal(store.getRun('old')?.status, 'sealed');
    issue(store, 'next', { now: 300 });
    assert.equal(store.getRun('old')?.reject_reason, 'abandoned');
    for (const id of ['b', 'c', 'next']) assert.equal(store.getRun(id)?.status, 'issued', id);
    assert.equal(store.getRun('a')?.reject_reason, 'abandoned');
    assert.equal(store.claim('old'), false);
  } finally {
    store.close();
  }
});

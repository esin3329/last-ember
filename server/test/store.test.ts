// SQLite 저장소의 발급 원자성·상한·프로세스 재시작·주기 정리 테스트.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Store, type VerifiedRun } from '../src/store.ts';

const verifiedRun: VerifiedRun = {
  name: 'player',
  score: 100,
  kills: 10,
  ticks: 1000,
  level: 2,
  won: false,
  inputs: '[4,1000]',
};

test('같은 issued_at에서는 rowid 순서로 정확히 최근 세 판만 남긴다', () => {
  const store = new Store(':memory:');
  try {
    const ip = '127.0.0.1';
    store.issueRun('verifying', 1, 1, ip, 100, 3);
    store.claim('verifying');
    store.issueRun('verified', 1, 1, ip, 100, 3);
    store.claim('verified');
    store.markVerified('verified', verifiedRun, 150);
    store.issueRun('rejected', 1, 1, ip, 100, 3);
    store.claim('rejected');
    store.markRejected('rejected', 'mismatch', 150);
    store.issueRun('other-ip', 1, 1, '127.0.0.2', 100, 3);

    // ID 사전순과 반대로 발급해서 동일 시각의 삽입 순서까지 확인한다.
    const ids = ['z', 'y', 'x', 'w', 'v', 'u'];
    for (const [index, id] of ids.entries()) {
      store.issueRun(id, 1, 1, ip, 100, 3);
      for (let i = 0; i <= index; i++) {
        const run = store.getRun(ids[i]);
        const abandoned = i <= index - 3;
        assert.equal(run?.status, abandoned ? 'rejected' : 'issued', ids[i]);
        assert.equal(run?.reject_reason, abandoned ? 'abandoned' : null, ids[i]);
      }
    }
    assert.equal(store.claim('z'), false);

    // 상한을 낮추면 한 번에 여러 판을 회수하며, 최소 상한 1도 정확히 지킨다.
    store.issueRun('only-open', 1, 1, ip, 100, 1);
    for (const id of ids) assert.equal(store.getRun(id)?.reject_reason, 'abandoned');
    assert.equal(store.getRun('only-open')?.status, 'issued');
    assert.equal(store.getRun('other-ip')?.status, 'issued');
    assert.equal(store.getRun('verifying')?.status, 'verifying');
    assert.equal(store.getRun('verified')?.status, 'verified');
    assert.equal(store.getRun('rejected')?.reject_reason, 'mismatch');
  } finally {
    store.close();
  }
});

test('INSERT 실패는 앞서 회수한 판까지 되돌리고 다음 발급을 허용한다', () => {
  const store = new Store(':memory:');
  try {
    for (const [index, id] of ['oldest', 'middle', 'newest'].entries()) {
      store.issueRun(id, 1, 1, '127.0.0.1', 100 + index, 3);
    }
    assert.throws(
      () => store.issueRun('middle', 1, 1, '127.0.0.1', 200, 3),
      /UNIQUE constraint failed/,
    );
    for (const id of ['oldest', 'middle', 'newest']) {
      assert.equal(store.getRun(id)?.status, 'issued');
      assert.equal(store.getRun(id)?.reject_reason, null);
    }
    store.issueRun('next', 1, 1, '127.0.0.1', 201, 3);
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
    const store = new Store(':memory:');
    // 실제 SQLite 트리거로 자동 롤백을 재현한다. 운영 코드에 테스트용 주입 API는 두지 않는다.
    const db = Reflect.get(store, 'db') as DatabaseSync;
    try {
      store.issueRun('oldest', 1, 1, '127.0.0.1', 100, 1);
      db.exec(`CREATE TRIGGER fail_issue BEFORE ${operation}
               BEGIN SELECT RAISE(ROLLBACK, 'automatic rollback'); END`);
      assert.throws(
        () => store.issueRun('next', 1, 1, '127.0.0.1', 200, 1),
        /automatic rollback/,
      );
      assert.equal(db.isTransaction, false);
      assert.equal(store.getRun('oldest')?.status, 'issued');
      assert.equal(store.getRun('oldest')?.reject_reason, null);
      assert.equal(store.getRun('next'), undefined);

      db.exec('DROP TRIGGER fail_issue');
      store.issueRun('next', 1, 1, '127.0.0.1', 201, 1);
      assert.equal(store.getRun('oldest')?.reject_reason, 'abandoned');
      assert.equal(store.getRun('next')?.status, 'issued');
    } finally {
      store.close();
    }
  });
}

for (const operation of ['BEGIN IMMEDIATE', 'COMMIT']) {
  test(`${operation} 실패가 부분 발급이나 열린 트랜잭션을 남기지 않는다`, (t) => {
    const store = new Store(':memory:');
    const db = Reflect.get(store, 'db') as DatabaseSync;
    try {
      store.issueRun('oldest', 1, 1, '127.0.0.1', 100, 1);
      const failure = new Error(`${operation} failed`);
      const exec = db.exec;
      const fault = t.mock.method(db, 'exec', (sql: string) => {
        if (sql === operation) throw failure;
        return exec.call(db, sql);
      });
      assert.throws(
        () => store.issueRun('next', 1, 1, '127.0.0.1', 200, 1),
        (err) => err === failure,
      );
      assert.equal(db.isTransaction, false);
      assert.equal(store.getRun('oldest')?.status, 'issued');
      assert.equal(store.getRun('oldest')?.reject_reason, null);
      assert.equal(store.getRun('next'), undefined);
      fault.mock.restore();

      store.issueRun('next', 1, 1, '127.0.0.1', 201, 1);
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
    const store = new Store(path);
    const db = Reflect.get(store, 'db') as DatabaseSync;
    try {
      store.issueRun('oldest', 1, 1, '127.0.0.1', 100, 1);
      const commitError = new Error('commit failed');
      const rollbackError = new Error('rollback failed');
      const exec = db.exec;
      t.mock.method(db, 'exec', (sql: string) => {
        if (sql === 'COMMIT') throw commitError;
        if (sql === 'ROLLBACK') throw rollbackError;
        return exec.call(db, sql);
      });
      assert.throws(
        () => store.issueRun('next', 1, 1, '127.0.0.1', 200, 1),
        (err) => {
          assert.ok(err instanceof AggregateError);
          assert.deepEqual(err.errors, [commitError, rollbackError]);
          return true;
        },
      );
      assert.equal(db.isOpen, false);
      assert.throws(() => store.issueRun('another', 1, 1, '127.0.0.1', 300, 1));
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

    const reopened = new Store(path);
    try {
      assert.equal(reopened.getRun('oldest')?.status, 'issued');
      assert.equal(reopened.getRun('oldest')?.reject_reason, null);
      assert.equal(reopened.getRun('next'), undefined);
      reopened.issueRun('next', 1, 1, '127.0.0.1', 300, 1);
      assert.equal(reopened.getRun('next')?.status, 'issued');
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('재시작 시 verifying 판을 rejected(interrupted)로 회수한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-ember-store-'));
  const path = join(dir, 'runs.db');
  try {
    const beforeRestart = new Store(path);
    try {
      beforeRestart.issueRun('interrupted-run', 1, 1, '127.0.0.1', 100, 3);
      assert.equal(beforeRestart.claim('interrupted-run'), true);
      beforeRestart.issueRun('issued', 1, 1, '127.0.0.1', 100, 3);
      beforeRestart.issueRun('verified', 1, 1, '127.0.0.1', 100, 3);
      beforeRestart.claim('verified');
      beforeRestart.markVerified('verified', verifiedRun, 150);
      beforeRestart.issueRun('rejected', 1, 1, '127.0.0.1', 100, 3);
      beforeRestart.claim('rejected');
      beforeRestart.markRejected('rejected', 'mismatch', 150);
    } finally {
      beforeRestart.close();
    }

    const afterRestart = new Store(path);
    try {
      const run = afterRestart.getRun('interrupted-run');
      assert.equal(run?.status, 'rejected');
      assert.equal(run?.reject_reason, 'interrupted');
      assert.equal(afterRestart.claim('interrupted-run'), false);
      assert.equal(afterRestart.getRun('issued')?.status, 'issued');
      assert.equal(afterRestart.getRun('verified')?.status, 'verified');
      assert.equal(afterRestart.getRun('verified')?.score, verifiedRun.score);
      assert.equal(afterRestart.getRun('rejected')?.reject_reason, 'mismatch');
    } finally {
      afterRestart.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('주기 정리는 오래된 verifying 판을 interrupted로 회수한다', () => {
  const store = new Store(':memory:');
  try {
    store.issueRun('stale-verifying-run', 1, 1, '127.0.0.1', 100, 3);
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
  const store = new Store(':memory:');
  const db = Reflect.get(store, 'db') as DatabaseSync;
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
      store.issueRun(id, 1, 1, '127.0.0.1', issuedAt, 20);
    }
    for (const id of ['stale-verifying', 'boundary-verifying', 'fresh-verifying']) {
      store.claim(id);
    }
    for (const [id, rejectedAt] of [
      ['stale-rejected', 199],
      ['boundary-rejected', 200],
      ['fresh-rejected', 250],
    ] as const) {
      store.claim(id);
      store.markRejected(id, 'mismatch', rejectedAt);
    }
    db.exec("UPDATE runs SET status = 'rejected' WHERE id = 'legacy-rejected'");
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

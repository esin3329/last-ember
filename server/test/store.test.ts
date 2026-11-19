// SQLite 저장소의 프로세스 재시작·주기 정리 복구 테스트.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/store.ts';

test('재시작 시 verifying 판을 rejected(interrupted)로 회수한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'last-ember-store-'));
  const path = join(dir, 'runs.db');
  try {
    const beforeRestart = new Store(path);
    try {
      beforeRestart.issueRun('interrupted-run', 1, 1, '127.0.0.1', 100, 3);
      assert.equal(beforeRestart.claim('interrupted-run'), true);
    } finally {
      beforeRestart.close();
    }

    const afterRestart = new Store(path);
    try {
      const run = afterRestart.getRun('interrupted-run');
      assert.equal(run?.status, 'rejected');
      assert.equal(run?.reject_reason, 'interrupted');
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

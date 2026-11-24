// SQLite 백업 스크립트 테스트: 일관된 복사본, 덮어쓰기 거절, 실패 시 잔여 파일 없음.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BackupError, backupDatabase } from '../../scripts/backup.ts';

let dir = '';
let sourcePath = '';
let source: DatabaseSync;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'last-ember-backup-'));
  sourcePath = join(dir, 'runs.db');
  source = new DatabaseSync(sourcePath);
  source.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  source.exec('CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = source.prepare('INSERT INTO runs (name) VALUES (?)');
  for (let i = 0; i < 200; i++) insert.run(`player-${i}`);
});

after(() => {
  source.close();
  rmSync(dir, { recursive: true, force: true });
});

function names(path: string): string[] {
  return readdirSync(path).sort();
}

test('WAL에만 있는 최신 데이터까지 담은 단일 파일 백업을 만든다', async () => {
  // 자동 체크포인트를 껐으므로 위 행들은 본 DB 파일이 아니라 -wal에 있다.
  assert.ok(existsSync(`${sourcePath}-wal`));
  const out = join(dir, 'backups') + '/';
  const result = await backupDatabase({ source: sourcePath, out, now: () => new Date('2026-11-24T03:04:05.678Z') });

  assert.equal(result.path, join(out, 'runs-20261124T030405Z.db'));
  assert.deepEqual(names(out), ['runs-20261124T030405Z.db']); // 임시·-wal·-shm 잔여물 없음

  const copy = new DatabaseSync(result.path, { readOnly: true });
  try {
    assert.equal((copy.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n, 200);
    assert.equal((copy.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete');
    assert.deepEqual(copy.prepare('PRAGMA integrity_check').all().map((r) => ({ ...r })), [{ integrity_check: 'ok' }]);
  } finally {
    copy.close();
  }
  // 원본은 그대로 WAL 모드로 계속 쓸 수 있다.
  assert.equal((source.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
});

test('파일 경로를 주면 그 이름으로 만들고, 이미 있으면 덮어쓰지 않는다', async () => {
  const target = join(dir, 'explicit', 'nested', 'copy.db');
  const result = await backupDatabase({ source: sourcePath, out: target });
  assert.equal(result.path, target);

  const before = new DatabaseSync(target, { readOnly: true });
  const first = before.prepare('SELECT count(*) AS n FROM runs').get();
  before.close();

  source.prepare('INSERT INTO runs (name) VALUES (?)').run('late');
  await assert.rejects(backupDatabase({ source: sourcePath, out: target }), /이미 있습니다/);

  const after = new DatabaseSync(target, { readOnly: true });
  assert.equal((after.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n, (first as { n: number }).n);
  after.close();
  assert.deepEqual(names(join(dir, 'explicit', 'nested')), ['copy.db']);
});

test('같은 초에 같은 디렉터리로 두 번 백업하면 두 번째는 실패하고 첫 백업을 보존한다', async () => {
  const out = join(dir, 'same-second') + '/';
  const now = () => new Date('2026-01-02T03:04:05Z');
  const first = await backupDatabase({ source: sourcePath, out, now });
  await assert.rejects(backupDatabase({ source: sourcePath, out, now }), /이미 있습니다/);
  assert.deepEqual(names(out), [first.path.split(/[\\/]/).pop()!]);
});

test('원본 DB와 그 -wal 파일을 대상으로 지정할 수 없다', async () => {
  await assert.rejects(backupDatabase({ source: sourcePath, out: sourcePath }), BackupError);
  await assert.rejects(backupDatabase({ source: sourcePath, out: `${sourcePath}-wal` }), BackupError);
  await assert.rejects(backupDatabase({ source: sourcePath, out: `${sourcePath}-shm` }), BackupError);
  assert.equal((source.prepare('SELECT count(*) AS n FROM runs WHERE name = ?').get('player-0') as { n: number }).n, 1);
});

test('없는 원본은 실패하고 빈 DB 파일을 새로 만들지 않는다', async () => {
  const missing = join(dir, 'missing.db');
  const out = join(dir, 'missing-out') + '/';
  await assert.rejects(backupDatabase({ source: missing, out }), /원본 DB 파일이 없습니다/);
  assert.equal(existsSync(missing), false);
  assert.deepEqual(existsSync(out) ? names(out) : [], []);
  await assert.rejects(backupDatabase({ source: ':memory:', out }), /파일 DB/);
});

test('SQLite가 아닌 원본은 실패하고 임시·부분 파일을 남기지 않는다', async () => {
  const bogus = join(dir, 'bogus.db');
  writeFileSync(bogus, 'this is not a sqlite database '.repeat(100));
  const out = join(dir, 'bogus-out');
  mkdirSync(out);
  await assert.rejects(backupDatabase({ source: bogus, out: join(out, 'x.db') }));
  assert.deepEqual(names(out), []);
});

test('테이블이 없는 빈 DB는 백업으로 인정하지 않는다', async () => {
  const empty = join(dir, 'empty.db');
  new DatabaseSync(empty).close();
  const out = join(dir, 'empty-out');
  mkdirSync(out);
  await assert.rejects(backupDatabase({ source: empty, out }), /테이블이 없습니다/);
  assert.deepEqual(names(out), []);
});

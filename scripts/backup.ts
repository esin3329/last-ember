// SQLite 온라인 백업. 서버가 실행 중이어도 일관된 스냅샷을 만든다.
//
//   node scripts/backup.ts [--db <경로>] [--out <디렉터리 또는 파일>]
//
//   --db   원본 DB. 기본 DB_PATH 환경 변수, 없으면 data/runs.db
//   --out  대상. 기존 디렉터리이거나 / 로 끝나면(없으면 생성) 그 안에 runs-<UTC 시각>.db 를 만든다. 기본 data/backups
//          파일 경로를 주면 그 이름으로 만든다. 이미 있는 파일은 덮어쓰지 않는다.
//
// node:sqlite의 backup()만 쓴다(-wal/-shm 파일을 직접 복사하지 않는다). 흐름:
//   1. 같은 디렉터리에 0600 임시 파일을 배타적으로 만든다.
//   2. 원본을 읽기 전용으로 열어(없는 경로를 새로 만들지 않는다) 임시 파일로 backup()한다.
//   3. 임시 파일을 단일 파일 DB(journal_mode=DELETE)로 만들고 integrity_check·foreign_key_check를 통과시킨다.
//   4. 디스크에 flush한 뒤 하드 링크로 최종 이름을 붙인다(이미 있으면 실패, 덮어쓰기 없음).
// 어느 단계든 실패하면 임시 파일을 지우고 최종 파일은 만들어지지 않으며 종료 코드 1을 낸다.

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';

export class BackupError extends Error {}

export interface BackupOptions {
  /** 원본 DB 파일. */
  source: string;
  /** 대상 디렉터리(없으면 만든다) 또는 새 파일 경로. */
  out: string;
  now?: () => Date;
}

export interface BackupResult {
  path: string;
  bytes: number;
  pages: number;
}

const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'];
/** 한 번에 전체 페이지를 복사해 읽기 잠금 한 번으로 일관된 스냅샷을 얻는다. */
const ALL_PAGES_PER_STEP = 0x7fffffff;
const BUSY_TIMEOUT_MS = 10_000;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 실제 경로(심볼릭 링크 해소) 기준으로 원본 DB와 그 부속 파일을 가리키는지 확인한다. */
function targetsSource(target: string, source: string): boolean {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (path: string) => (caseInsensitive ? path.toLowerCase() : path);
  const candidate = fold(join(realpathSync(dirname(target)), basename(target)));
  const realSource = realpathSync(source);
  return SQLITE_SIDECARS.some((suffix) => candidate === fold(realSource + suffix));
}

function verifyBackup(path: string): void {
  // 읽기/쓰기로 열어 헤더의 WAL 모드를 해제한다. 백업 파일 하나만으로 복원할 수 있어야 한다.
  const db = new DatabaseSync(path);
  try {
    const mode = db.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode: string };
    if (mode.journal_mode !== 'delete') throw new BackupError(`백업 파일을 단일 파일 모드로 바꾸지 못했습니다: ${mode.journal_mode}`);
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new BackupError(`백업 무결성 검사 실패: ${integrity.map((r) => r.integrity_check).slice(0, 5).join('; ')}`);
    }
    const foreign = db.prepare('PRAGMA foreign_key_check').all();
    if (foreign.length > 0) throw new BackupError(`백업 외래 키 검사 실패: ${foreign.length}건`);
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as { n: number };
    if (tables.n === 0) throw new BackupError('백업에 테이블이 없습니다(원본이 비어 있거나 SQLite DB가 아닙니다)');
  } finally {
    db.close();
  }
}

function flushToDisk(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeTemp(tmp: string): void {
  for (const suffix of SQLITE_SIDECARS) rmSync(tmp + suffix, { force: true });
}

export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  const source = resolve(options.source);
  if (options.source === ':memory:' || options.source === '') throw new BackupError('원본은 파일 DB여야 합니다');
  if (!existsSync(source) || !statSync(source).isFile()) throw new BackupError(`원본 DB 파일이 없습니다: ${source}`);

  const out = resolve(options.out);
  const outIsDirectory = isDirectory(out) || /[\\/]$/.test(options.out);
  mkdirSync(outIsDirectory ? out : dirname(out), { recursive: true, mode: 0o700 });
  const target = outIsDirectory
    ? join(out, `runs-${(options.now ?? (() => new Date()))().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.db`)
    : out;

  if (targetsSource(target, source)) throw new BackupError('대상이 원본 DB(또는 그 -wal/-shm/-journal)와 같습니다');
  if (existsSync(target)) throw new BackupError(`대상이 이미 있습니다(덮어쓰지 않음): ${target}`);

  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  // 'wx': 이미 있으면 실패. 소유자만 읽고 쓰는 권한으로 만든다.
  closeSync(openSync(tmp, 'wx', 0o600));

  let pages: number;
  try {
    const db = new DatabaseSync(source, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
    try {
      pages = await backup(db, tmp, { rate: ALL_PAGES_PER_STEP });
    } finally {
      db.close();
    }
    verifyBackup(tmp);
    flushToDisk(tmp);
    // 하드 링크는 최종 이름이 이미 있으면 EEXIST로 실패한다. 이름 점검과 생성 사이 경쟁에서도 덮어쓰지 않는다.
    try {
      linkSync(tmp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new BackupError(`대상이 이미 있습니다(덮어쓰지 않음): ${target}`);
      }
      throw error;
    }
    return { path: target, bytes: statSync(target).size, pages };
  } finally {
    removeTemp(tmp);
  }
}

function parseArgs(argv: string[]): { db?: string; out?: string } {
  const result: { db?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag !== '--db' && flag !== '--out') || value === undefined || value === '') {
      throw new BackupError('사용법: node scripts/backup.ts [--db <경로>] [--out <디렉터리 또는 파일>]');
    }
    result[flag === '--db' ? 'db' : 'out'] = value;
  }
  return result;
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await backupDatabase({
      source: args.db ?? process.env.DB_PATH ?? resolve(root, 'data/runs.db'),
      out: args.out ?? resolve(root, 'data/backups') + sep,
    });
    console.log(JSON.stringify({ event: 'backup_ok', ...result }));
  } catch (error) {
    console.error(JSON.stringify({ event: 'backup_failed', message: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

// 서버 진입점.  PORT, DB_PATH, VERIFY_WORKERS, TRUST_PROXY 환경 변수로 설정한다.

import { existsSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { VerifierPool } from './verifier.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? resolve(root, 'data/runs.db');
const workers = Number(process.env.VERIFY_WORKERS ?? Math.max(1, Math.min(4, availableParallelism() - 1)));
const trustProxyHops = Number(process.env.TRUST_PROXY ?? 0);
const distDir = resolve(root, 'dist');

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const store = new Store(dbPath);
const pool = new VerifierPool(workers);
const server = createApp({
  store,
  verify: pool.verify,
  staticDir: existsSync(distDir) ? distDir : undefined,
  trustProxyHops,
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

server.listen(port, () => {
  console.log(`LAST EMBER 서버 http://localhost:${port}  (검증 워커 ${workers}개, DB ${dbPath})`);
  if (!existsSync(distDir)) console.log('dist가 없어 API만 제공합니다. 클라이언트는 npm run dev:client 또는 npm run build.');
});

// 종료 신호를 받으면 새 연결을 막고 진행 중인 요청을 끝낸 뒤 자원을 정리한다.
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  server.close();
  await pool.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 서버 진입점.  PORT, DB_PATH, VERIFY_WORKERS, TRUST_PROXY, SHUTDOWN_TIMEOUT_MS 환경 변수로 설정한다.

import { existsSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShutdownTimeoutMs } from './config.ts';
import { createApp, validateTrustProxyHops } from './app.ts';
import { Store } from './store.ts';
import { parseVerifierWorkerCount, VerifierPool } from './verifier.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH ?? resolve(root, 'data/runs.db');
const workers = parseVerifierWorkerCount(
  process.env.VERIFY_WORKERS,
  Math.max(1, Math.min(4, availableParallelism() - 1)),
);

const shutdownTimeoutMs = parseShutdownTimeoutMs(process.env.SHUTDOWN_TIMEOUT_MS);
const trustProxyHops = Number(process.env.TRUST_PROXY ?? 0);
validateTrustProxyHops(trustProxyHops);
const distDir = resolve(root, 'dist');

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const store = new Store(dbPath);
const pool = new VerifierPool(workers, {
  onFatal: (error) => {
    console.error(`[${new Date().toISOString()}] 검증 워커 풀 장애로 서버를 종료합니다: ${error.message}`);
    void shutdown(1);
  },
});
const server = createApp({
  store,
  verify: pool.verify,
  staticDir: existsSync(distDir) ? distDir : undefined,
  trustProxyHops,
  healthy: () => !closing && !pool.isClosed,
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

server.listen(port, () => {
  console.log(`LAST EMBER 서버 http://localhost:${port}  (검증 워커 ${workers}개, DB ${dbPath})`);
  if (!existsSync(distDir)) console.log('dist가 없어 API만 제공합니다. 클라이언트는 npm run dev:client 또는 npm run build.');
});

// 종료 신호나 치명적인 워커 오류를 받으면 설정된 제한 시간 동안 요청·자원을 정리한다.
let closing = false;
let shutdownExitCode = 0;
async function shutdown(exitCode = 0): Promise<void> {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => {
    console.error(`[${new Date().toISOString()}] 서버 종료 제한 시간(${shutdownTimeoutMs}ms)을 초과하여 강제 종료합니다.`);
    server.closeAllConnections();
    process.exit(1);
  }, shutdownTimeoutMs);
  const serverClosed = new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  try {
    await serverClosed;
  } finally {
    try {
      await pool.close();
    } finally {
      store.close();
      clearTimeout(deadline);
      process.exit(shutdownExitCode);
    }
  }
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });

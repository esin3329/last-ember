// 서버 진입점. 저장소와 워커를 만들기 전에 운영 설정을 확인한다.

import { existsSync, mkdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShutdownTimeoutMs } from './config.ts';
import { createApp } from './app.ts';
import { writeLog } from './logging.ts';
import { Store } from './store.ts';
import { parseTrustProxyConfig } from './trustedProxy.ts';
import { parseVerifierWorkerCount, VerifierPool } from './verifier.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST;
const dbPath = process.env.DB_PATH ?? resolve(root, 'data/runs.db');
const workers = parseVerifierWorkerCount(
  process.env.VERIFY_WORKERS,
  Math.max(1, Math.min(4, availableParallelism() - 1)),
);

const shutdownTimeoutMs = parseShutdownTimeoutMs(process.env.SHUTDOWN_TIMEOUT_MS);
const trustProxy = parseTrustProxyConfig({
  TRUST_PROXY: process.env.TRUST_PROXY,
  TRUST_PROXY_CIDRS: process.env.TRUST_PROXY_CIDRS,
});
const distDir = resolve(root, 'dist');
const servingClient = existsSync(distDir);

if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

const store = new Store(dbPath);
const pool = new VerifierPool(workers, {
  onFatal: (error) => {
    writeLog({ event: 'verifier_fatal', message: `검증 워커 풀 장애로 서버를 종료합니다: ${error.message}` }, 'error');
    void shutdown(1);
  },
});
const server = createApp({
  store,
  verify: pool.verify,
  staticDir: servingClient ? distDir : undefined,
  trustProxy,
  healthy: () => !closing && !pool.isClosed,
  log: (event) => writeLog(event, event.event === 'request_error' ? 'error' : 'info'),
});

server.listen({ port, host }, () => {
  const bound = server.address();
  writeLog({
    event: 'server_started',
    host: typeof bound === 'object' && bound !== null ? bound.address : host,
    port: typeof bound === 'object' && bound !== null ? bound.port : port,
    workers,
    servingClient,
    message: servingClient ? 'LAST EMBER 서버 시작' : 'LAST EMBER 서버 시작 — dist가 없어 API만 제공합니다.',
  });
});

// 종료 신호나 치명적인 워커 오류를 받으면 설정된 제한 시간 동안 요청·자원을 정리한다.
let closing = false;
let shutdownExitCode = 0;
async function shutdown(exitCode = 0): Promise<void> {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => {
    writeLog({
      event: 'shutdown_timeout',
      timeoutMs: shutdownTimeoutMs,
      message: `서버 종료 제한 시간(${shutdownTimeoutMs}ms)을 초과하여 강제 종료합니다.`,
    }, 'error');
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

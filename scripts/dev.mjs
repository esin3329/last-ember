// 개발용: API 서버(8787)와 Vite 개발 서버(5173)를 함께 띄운다.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// PORT 환경 변수는 화면(Vite) 포트로만 쓰고, API 서버는 항상 8787에 띄운다(Vite 프록시 대상).
const webPort = process.env.PORT ?? '5173';
const procs = [
  spawn(process.execPath, ['--watch', 'server/src/main.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: '8787' } }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', webPort, '--strictPort'], { cwd: root, stdio: 'inherit' }),
];

function stop() {
  for (const p of procs) p.kill();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);

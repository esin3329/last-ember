import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

interface FixtureMessage {
  event: string;
  port?: number;
}

interface Runtime {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitFor: (event: string) => Promise<FixtureMessage>;
  command: (value: string) => Promise<void>;
  stderr: () => string;
}

const QUICK_SHUTDOWN_TIMEOUT_MS = 300;
const SAFE_SHUTDOWN_TIMEOUT_MS = 5_000;

function launch(t: TestContext, shutdownTimeoutMs = QUICK_SHUTDOWN_TIMEOUT_MS): Runtime {
  const child = fork(new URL('./shutdownFixture.ts', import.meta.url), [], {
    execArgv: [],
    env: {
      ...process.env,
      PORT: '0',
      DB_PATH: ':memory:',
      VERIFY_WORKERS: '2',
      TRUST_PROXY: '0',
      TRUST_PROXY_CIDRS: '',
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
    },
    silent: true,
  });
  let stderr = '';
  child.stdout!.resume();
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr += chunk; });
  const exited = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  const messages: FixtureMessage[] = [];
  const events = new EventEmitter();
  child.on('message', (message: FixtureMessage) => {
    messages.push(message);
    events.emit('received');
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });

  async function waitFor(event: string): Promise<FixtureMessage> {
    while (true) {
      const index = messages.findIndex((message) => message.event === event);
      if (index >= 0) return messages.splice(index, 1)[0];
      await Promise.race([
        once(events, 'received'),
        exited.then(({ code, signal }) => {
          throw new Error(`fixture exited before ${event}: ${code}/${signal}\n${stderr}`);
        }),
      ]);
    }
  }

  async function command(value: string): Promise<void> {
    child.send(value);
    await waitFor('command-complete');
  }

  return { exited, waitFor, command, stderr: () => stderr };
}

async function openPartialRequest(t: TestContext, runtime: Runtime) {
  const { port } = await runtime.waitFor('ready');
  assert.equal(typeof port, 'number');
  const socket = createConnection({ host: '127.0.0.1', port: port! });
  socket.on('error', () => {});
  t.after(() => { socket.destroy(); });
  await once(socket, 'connect');
  socket.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\n');
  await runtime.waitFor('request-started');
  return socket;
}

test('SIGTERM 뒤 기존 소켓에서 완성된 health 요청은 503이고 정상 종료 코드는 0이다', { timeout: 20_000 }, async (t) => {
  const runtime = launch(t, SAFE_SHUTDOWN_TIMEOUT_MS);
  const socket = await openPartialRequest(t, runtime);
  let response = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => { response += chunk; });
  const socketClosed = once(socket, 'close');
  await runtime.command('signal');
  socket.write('Connection: close\r\n\r\n');
  await socketClosed;
  assert.match(response, /^HTTP\/1\.1 503 /);
  assert.equal(JSON.parse(response.split('\r\n\r\n')[1]).ok, false);
  assert.deepEqual(await runtime.exited, { code: 0, signal: null });
  assert.doesNotMatch(runtime.stderr(), /강제 종료/);
});

for (const signalFirst of [true, false]) {
  test(`SIGTERM과 워커 장애가 겹쳐도 종료 코드는 1이다 (signal first: ${signalFirst})`, { timeout: 20_000 }, async (t) => {
    const runtime = launch(t, SAFE_SHUTDOWN_TIMEOUT_MS);
    const socket = await openPartialRequest(t, runtime);
    await runtime.command(signalFirst ? 'signal-then-fatal' : 'fatal');
    await runtime.waitFor('fatal');
    if (!signalFirst) await runtime.command('signal');
    socket.destroy();
    assert.deepEqual(await runtime.exited, { code: 1, signal: null });
    assert.match(runtime.stderr(), /검증 워커 풀 장애/);
    assert.doesNotMatch(runtime.stderr(), /강제 종료/);
  });
}

test('치명적 장애 후 클라이언트가 헤더를 끝내지 않아도 설정된 시간 뒤 강제 종료한다', { timeout: 20_000 }, async (t) => {
  const timeoutMs = QUICK_SHUTDOWN_TIMEOUT_MS;
  const runtime = launch(t, timeoutMs);
  const socket = await openPartialRequest(t, runtime);
  const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  await runtime.command('fatal');
  await runtime.waitFor('fatal');
  const started = performance.now();
  assert.deepEqual(await runtime.exited, { code: 1, signal: null });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= timeoutMs - 50 && elapsed < timeoutMs + 5_000, `shutdown took ${elapsed} ms`);
  await socketClosed;
  assert.match(runtime.stderr(), new RegExp(`종료 제한 시간\\(${timeoutMs}ms\\)`));
});

test('워커 종료가 멈춰도 즉시 장애를 알리고 SIGTERM으로 실패 코드를 덮지 않는다', { timeout: 20_000 }, async (t) => {
  const timeoutMs = QUICK_SHUTDOWN_TIMEOUT_MS;
  const runtime = launch(t, timeoutMs);
  await runtime.waitFor('ready');
  await runtime.command('fatal-stalled-worker');
  await runtime.waitFor('fatal');
  const started = performance.now();
  await runtime.command('signal');
  assert.deepEqual(await runtime.exited, { code: 1, signal: null });
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= timeoutMs - 50 && elapsed < timeoutMs + 5_000, `shutdown took ${elapsed} ms`);
  assert.match(runtime.stderr(), /검증 워커 풀 장애/);
  assert.match(runtime.stderr(), new RegExp(`종료 제한 시간\\(${timeoutMs}ms\\)`));
});

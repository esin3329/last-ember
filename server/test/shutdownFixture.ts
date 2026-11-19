// 실제 main과 HTTP 소켓을 사용하고 워커 장애·종료 정지만 주입한다.
import { Server } from 'node:http';
import type { Worker } from 'node:worker_threads';
import type { VerifyError } from '../src/verifier.ts';
import { VerifierPool } from '../src/verifier.ts';

interface PoolControl {
  spawn(): unknown;
  slots: { worker: Worker }[];
  workerFactory: () => Worker;
  onFatal?: (error: VerifyError) => void;
}

let pool: PoolControl;
const prototype = VerifierPool.prototype as unknown as PoolControl;
const spawn = prototype.spawn;
prototype.spawn = function () {
  if (!pool) {
    pool = this;
    const onFatal = this.onFatal;
    this.onFatal = (error) => {
      onFatal?.(error);
      process.send!({ event: 'fatal' });
    };
  }
  return spawn.call(this);
};

const listen = Server.prototype.listen;
Server.prototype.listen = function (this: Server, ...args: unknown[]) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address !== 'string') process.send!({ event: 'ready', port: address.port });
  });
  this.on('connection', (socket) => {
    socket.once('data', () => process.send!({ event: 'request-started' }));
  });
  return Reflect.apply(listen, this, args);
} as Server['listen'];

function failWorker(stallTermination = false): void {
  if (stallTermination) pool.slots[1].worker.terminate = () => new Promise<number>(() => {});
  pool.workerFactory = () => { throw new Error('injected replacement creation failure'); };
  pool.slots[0].worker.emit('error', new Error('injected worker failure'));
}

process.on('message', (command: string) => {
  // Windows에서도 OS의 강제 kill 대신 main에 등록된 신호 처리기를 호출한다.
  if (command === 'signal' || command === 'signal-then-fatal') process.emit('SIGTERM');
  if (command === 'fatal' || command === 'signal-then-fatal') failWorker();
  if (command === 'fatal-stalled-worker') failWorker(true);
  process.send!({ event: 'command-complete' });
});

// 모듈 초기화 경계를 검사하므로 main의 정적 import보다 먼저 장애 주입을 설치해야 한다.
await import('../src/main.ts');

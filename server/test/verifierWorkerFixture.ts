import { parentPort, workerData } from 'node:worker_threads';
import { simulate } from '../../shared/replay.ts';

interface Job {
  id: number;
  seed: number;
  runs: number[];
}

if (workerData === 'exit') {
  parentPort!.once('message', () => process.exit(0));
} else if (workerData === 'reply-exit') {
  parentPort!.once('message', (job: Job) => {
    parentPort!.postMessage({ id: job.id, result: simulate(job.seed, job.runs) });
    process.exit(0);
  });
} else if (workerData === 'error') {
  parentPort!.once('message', () => {
    throw new Error('test worker error');
  });
} else if (workerData === 'hang') {
  const lock = new Int32Array(new SharedArrayBuffer(4));
  parentPort!.once('message', () => Atomics.wait(lock, 0, 0, 60_000));
} else {
  parentPort!.on('message', (job: Job) => {
    parentPort!.postMessage({ id: job.id, result: simulate(job.seed, job.runs) });
  });
}

// 워커 스레드: 리플레이를 재실행해 결과를 돌려준다.
import { parentPort } from 'node:worker_threads';
import { simulate } from '../../shared/replay.ts';

parentPort!.on('message', (job: { id: number; seed: number; runs: number[] }) => {
  parentPort!.postMessage({ id: job.id, result: simulate(job.seed, job.runs) });
});

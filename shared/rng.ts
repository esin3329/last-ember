// 시드 기반 난수 생성기 (mulberry32).
// 시뮬레이션 안에서는 Math.random 대신 반드시 이 RNG만 사용한다.
// 정수 연산만 쓰므로 브라우저/Node/다른 언어 포팅에서도 같은 수열이 나온다.

export interface Rng {
  s: number;
}

export function makeRng(seed: number): Rng {
  return { s: seed | 0 };
}

export function nextU32(r: Rng): number {
  r.s = (r.s + 0x6d2b79f5) | 0;
  let t = Math.imul(r.s ^ (r.s >>> 15), 1 | r.s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}

/** [0, 1) */
export function nextFloat(r: Rng): number {
  return nextU32(r) / 4294967296;
}

/** [0, n) 정수 */
export function nextInt(r: Rng, n: number): number {
  return Math.floor(nextFloat(r) * n);
}

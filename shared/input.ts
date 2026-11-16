// 입력 프레임과 리플레이 인코딩.
// 한 틱의 입력을 1바이트 코드로 만들고, 같은 입력이 이어지는 구간을 RLE로 압축한다.
// 3분짜리 플레이(약 1만 틱)가 보통 수백 쌍으로 줄어든다.

export interface InputFrame {
  mx: number; // -1 | 0 | 1
  my: number; // -1 | 0 | 1
  dash: boolean;
  choice: number; // -1(없음) | 0 | 1 | 2  레벨업 선택지
}

// 비트 배치: [6..5] choice+1, [4] dash, [3..0] 이동(0~8)
export function encodeFrame(f: InputFrame): number {
  return (f.mx + 1) + (f.my + 1) * 3 + (f.dash ? 16 : 0) + ((f.choice + 1) << 5);
}

export function decodeFrame(code: number, out: InputFrame): InputFrame {
  const mv = code & 15;
  out.mx = (mv % 3) - 1;
  out.my = ((mv / 3) | 0) - 1;
  out.dash = (code & 16) !== 0;
  out.choice = ((code >> 5) & 3) - 1;
  return out;
}

export function isValidCode(code: number): boolean {
  return Number.isInteger(code) && code >= 0 && code < 128 && (code & 15) <= 8;
}

/** 입력 코드를 [code, count, code, count, ...] 형태로 기록한다. */
export class InputRecorder {
  readonly runs: number[] = [];
  total = 0;

  push(code: number): void {
    const n = this.runs.length;
    if (n > 0 && this.runs[n - 2] === code) this.runs[n - 1]++;
    else this.runs.push(code, 1);
    this.total++;
  }
}

/** RLE 쌍의 총 틱 수. 형식이 잘못됐으면 -1. */
export function countTicks(runs: unknown, maxTicks: number): number {
  if (!Array.isArray(runs) || runs.length % 2 !== 0) return -1;
  let total = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const code = runs[i];
    const count = runs[i + 1];
    if (!isValidCode(code)) return -1;
    if (!Number.isInteger(count) || count < 1) return -1;
    total += count;
    if (total > maxTicks) return -1;
  }
  return total;
}

export function expandRuns(runs: number[]): Uint8Array {
  let total = 0;
  for (let i = 1; i < runs.length; i += 2) total += runs[i];
  const out = new Uint8Array(total);
  let w = 0;
  for (let i = 0; i < runs.length; i += 2) {
    out.fill(runs[i], w, w + runs[i + 1]);
    w += runs[i + 1];
  }
  return out;
}

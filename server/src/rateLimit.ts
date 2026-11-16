// IP별 토큰 버킷 속도 제한. 현재 시각을 인자로 받아 테스트에서 시간을 조작할 수 있다.

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private capacity: number;
  private refillPerMs: number;

  /** capacity개까지 몰아서 허용하고, 분당 perMinute개씩 다시 채운다. */
  constructor(capacity: number, perMinute: number) {
    this.capacity = capacity;
    this.refillPerMs = perMinute / 60000;
  }

  take(key: string, now: number): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, last: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + (now - b.last) * this.refillPerMs);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** 가득 찬(= 오래 쉰) 버킷을 지워 메모리가 계속 늘지 않게 한다. */
  sweep(now: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (now - b.last) * this.refillPerMs >= this.capacity) this.buckets.delete(key);
    }
  }
}

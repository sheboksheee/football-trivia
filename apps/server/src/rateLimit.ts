/** Token bucket. Infrastructure safeguard, not a game rule. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.last = now;
  }
  take(now = Date.now(), n = 1): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
    this.last = now;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

export class KeyedLimiter {
  private buckets = new Map<string, TokenBucket>();
  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
  ) {}
  take(key: string, now = Date.now()): boolean {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 50_000) this.buckets.clear();
      b = new TokenBucket(this.capacity, this.refillPerSec, now);
      this.buckets.set(key, b);
    }
    return b.take(now);
  }
}

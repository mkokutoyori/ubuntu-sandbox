export interface RateLimit {
  readonly intervalExponent: number;
  readonly burst: number;
  readonly leakExponent: number;
  readonly kod: boolean;
}

interface Bucket { tokens: number; at: number; excess: number }

export type RateVerdict = 'serve' | 'kod' | 'drop';

export interface RateDecision { readonly verdict: RateVerdict; readonly limited: boolean }

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private limit: RateLimit | null) {}

  configure(limit: RateLimit | null): void {
    this.limit = limit;
    this.buckets.clear();
  }

  check(key: string, nowMs: number): RateDecision {
    const limit = this.limit;
    if (limit === null) return { verdict: 'serve', limited: false };
    const bucket = this.buckets.get(key) ?? { tokens: limit.burst, at: nowMs, excess: 0 };
    const refill = ((nowMs - bucket.at) / 1000) / 2 ** limit.intervalExponent;
    bucket.tokens = Math.min(limit.burst, bucket.tokens + refill);
    bucket.at = nowMs;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { verdict: 'serve', limited: false };
    }
    bucket.excess++;
    if (limit.kod) return { verdict: 'kod', limited: true };
    return { verdict: bucket.excess % 2 ** limit.leakExponent === 0 ? 'serve' : 'drop', limited: true };
  }
}

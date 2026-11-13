/**
 * In-memory token bucket per API token (or client IP for unauthenticated
 * requests). Capacity = limit per minute, refilled continuously. Single
 * process only, which matches how Steward runs.
 */
export interface RateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again */
  resetSeconds: number;
  /** Seconds until the next request is allowed (when not allowed) */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updated: number;
  capacity: number;
}

/** Buckets kept at most: a flood of new keys (addresses) cannot grow the map without bound (review 0.20.0, CWE-770). */
export const MAX_BUCKETS = 50_000;

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();
  private lastForcedSweep = 0;

  constructor(
    private now: () => number = Date.now,
    private maxBuckets = MAX_BUCKETS,
  ) {}

  /** Buckets currently kept (for tests). */
  get size(): number {
    return this.buckets.size;
  }

  take(key: string, perMinute: number): RateDecision {
    const now = this.now();
    this.sweep(now);
    const rate = perMinute / 60000; // tokens per ms
    let b = this.buckets.get(key);
    if (!b || b.capacity !== perMinute) {
      if (!b && this.buckets.size >= this.maxBuckets) {
        // full: drop idle buckets first (at most once a second: a scan of every bucket per request would be a load of its
        // own), then the oldest (a dropped bucket starts full again – it never limits more)
        if (now - this.lastForcedSweep >= 1000) {
          this.lastForcedSweep = now;
          this.sweep(now, true);
        }
        while (this.buckets.size >= this.maxBuckets) this.buckets.delete(this.buckets.keys().next().value!);
      }
      b = { tokens: perMinute, updated: now, capacity: perMinute };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(b.capacity, b.tokens + (now - b.updated) * rate);
    b.updated = now;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    return {
      allowed,
      limit: perMinute,
      remaining: Math.max(0, Math.floor(b.tokens)),
      resetSeconds: Math.ceil((b.capacity - b.tokens) / rate / 1000),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000)),
    };
  }

  /** Forget buckets that have been full for a while (keeps memory bounded). */
  private sweep(now: number, force = false): void {
    if (!force && now - this.lastSweep < 60000) return;
    this.lastSweep = now;
    for (const [k, b] of this.buckets)
      if (now - b.updated > 120000 || (force && b.tokens + (now - b.updated) * (b.capacity / 60000) >= b.capacity)) this.buckets.delete(k);
  }

  reset(): void {
    this.buckets.clear();
  }
}

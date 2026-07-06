// ── Token Bucket Rate Limiter ──
// Per-key rate limiting with priority: X-Worker-ID > source IP.
// Suitable for 10K+ RPS across 200+ workers.
//
// Key design decisions:
//  - Each Go worker sends X-Worker-ID → independent bucket (no cross-worker throttling)
//  - If no X-Worker-ID, falls back to IP — all workers behind same NAT share one bucket
//  - Bounded memory: Map with periodic stale cleanup
//  - O(1) token consumption, lock-free (JS single-threaded)

import { config } from './config.js';

class TokenBucket {
  constructor(rate, burst) {
    this.rate = rate;          // tokens per second
    this.burst = burst;        // max token capacity
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  /** Attempt to consume N tokens. Returns true if allowed. */
  consume(n = 1) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Refill tokens based on elapsed time. Thread-safe (single-threaded JS). */
  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  /** Current available tokens (refills first). */
  get available() {
    this._refill();
    return this.tokens;
  }
}

export class RateLimiter {
  constructor() {
    this.enabled = config.rateLimit.enabled;
    this.buckets = new Map();
    this.maxBuckets = config.rateLimit.maxBuckets;
    this.bucketTTL = config.rateLimit.bucketTTLMs;
    this.rate = config.rateLimit.tokensPerSecond;
    this.burst = config.rateLimit.burst;

    if (this.enabled) {
      this._cleanupTimer = setInterval(
        () => this._cleanup(),
        config.rateLimit.cleanupIntervalMs
      ).unref();
    }
  }

  /**
   * Check if a request from `key` is allowed.
   * Returns { allowed: boolean, retryAfterMs?: number }
   */
  check(key) {
    if (!this.enabled) return { allowed: true };

    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Under extreme memory pressure, allow but don't track new keys.
      if (this.buckets.size >= this.maxBuckets) {
        return { allowed: true };
      }
      bucket = new TokenBucket(this.rate, this.burst);
      this.buckets.set(key, bucket);
    }

    if (bucket.consume(1)) {
      return { allowed: true };
    }

    // Estimate retry-after from token deficit.
    const deficit = 1 - bucket.available;
    const retryAfterMs = Math.ceil((deficit / this.rate) * 1000);

    return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 10) };
  }

  /** Remove expired buckets to bound memory. */
  _cleanup() {
    const cutoff = Date.now() - this.bucketTTL;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  /** Current number of tracked keys. */
  get size() {
    return this.buckets.size;
  }

  destroy() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
    }
    this.buckets.clear();
  }
}

export default RateLimiter;

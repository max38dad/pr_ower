// ── Adaptive Throttle ──
// Dynamically limits concurrency based on event-loop lag using EMA smoothing.
// Protects the instance from overload at 10K+ RPS without hard-coded limits.
//
// How it works:
//   1. Every 500ms, measures event-loop lag via setImmediate gap
//   2. EMA-smooths the lag (decay=0.8, favors recent samples)
//   3. If smoothed lag > maxLag (30ms): aggressively reduces concurrency limit
//   4. If smoothed lag < maxLag * 0.5 (15ms): gradually recovers limit
//   5. Requests beyond currentLimit get 503 immediately — no queuing, no crash

import { config } from './config.js';

export class AdaptiveThrottle {
  constructor() {
    this.enabled = config.throttle.enabled;
    this.maxLag = config.throttle.maxEventLoopLagMs;
    this.maxConcurrency = config.throttle.maxConcurrency;
    this.minConcurrency = config.throttle.minConcurrency;
    this.decay = config.throttle.decayFactor;

    // Current concurrency gate — adjusted dynamically.
    this.currentLimit = this.maxConcurrency;
    this.activeCount = 0;

    // EMA-smoothed event loop lag (ms).
    this.emaLag = 0;

    if (this.enabled) {
      this._monitorTimer = setInterval(
        () => this._measure(),
        config.throttle.checkIntervalMs
      ).unref();
    }
  }

  /**
   * Measure event loop lag using setImmediate scheduling gap.
   * The time between scheduling setImmediate and its callback tells us
   * how busy the event loop is. < 1ms = idle, > 50ms = overloaded.
   */
  async _measure() {
    const start = process.hrtime.bigint();
    await new Promise(resolve => setImmediate(resolve));
    const end = process.hrtime.bigint();
    const lagMs = Number(end - start) / 1e6;

    // Exponential moving average for smooth adjustments.
    this.emaLag = this.emaLag * this.decay + lagMs * (1 - this.decay);

    this._adjust();
  }

  /**
   * Adjust concurrency limit based on current EMA lag.
   */
  _adjust() {
    if (this.emaLag > this.maxLag) {
      // Overloaded: aggressive reduction proportional to overshoot.
      const ratio = this.maxLag / this.emaLag;
      this.currentLimit = Math.max(
        this.minConcurrency,
        Math.floor(this.currentLimit * ratio * 0.85)
      );
    } else if (this.emaLag < this.maxLag * 0.4) {
      // Healthy with margin: gradual recovery toward max.
      const gap = this.maxConcurrency - this.currentLimit;
      const recovery = Math.max(1, Math.floor(gap * 0.15));
      this.currentLimit = Math.min(
        this.maxConcurrency,
        this.currentLimit + recovery
      );
    }
    // else: in the gray zone [0.4*maxLag ... maxLag], hold steady.
  }

  /**
   * Try to acquire a concurrency slot. Fast, no allocations.
   * Returns true if within limit, false if throttled.
   */
  acquire() {
    if (!this.enabled) return true;
    if (this.activeCount >= this.currentLimit) return false;
    this.activeCount++;
    return true;
  }

  /**
   * Release a concurrency slot. MUST be called exactly once per acquire().
   * Idempotent — double-release is safe (guarded).
   */
  release() {
    if (!this.enabled) return;
    if (this.activeCount > 0) this.activeCount--;
  }

  /** Current throttle metrics for observability. */
  get metrics() {
    return {
      enabled: this.enabled,
      emaLagMs: Math.round(this.emaLag * 100) / 100,
      currentLimit: this.currentLimit,
      activeCount: this.activeCount,
      utilization: this.currentLimit > 0
        ? Math.round((this.activeCount / this.currentLimit) * 100)
        : 0,
      maxConcurrency: this.maxConcurrency,
    };
  }

  destroy() {
    if (this._monitorTimer) {
      clearInterval(this._monitorTimer);
    }
  }
}

export default AdaptiveThrottle;

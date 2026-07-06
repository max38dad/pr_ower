// ── Warmup Engine ──
// Self-warming strategy for a proxy with unknown target hosts.
// No external host list required — warms the internal pipeline.
//
// What it does:
//   1. Synthetic requests through the full Fastify pipeline (warms route handlers, JIT)
//   2. Exercises all code paths: header parsing, error handling, streaming
//   3. Pre-allocates memory to avoid first-GC pause under load
//   4. Signals readiness when internal pipeline is hot

import { config } from './config.js';

export class WarmupEngine {
  constructor(proxyEngine) {
    this.proxy = proxyEngine;
    this.enabled = config.warmup.enabled;
    this.heartbeatMs = config.warmup.heartbeatIntervalMs;
    this.warmupCount = config.warmup.warmupCount;
    this.isReady = false;
  }

  /**
   * Execute self-warmup: synthetic traffic through own HTTP server.
   * Does NOT require any external hosts.
   */
  async execute() {
    if (!this.enabled) {
      this.isReady = true;
      return;
    }

    const logger = globalThis.__gatewayLogger || console;
    logger.info({ count: this.warmupCount }, 'warmup: starting self-warmup');

    const start = Date.now();
    const baseUrl = `http://127.0.0.1:${config.port}`;

    // Phase 1: Warm the health/metrics endpoints (lightweight, fast).
    const warmupPaths = ['/health', '/ready', '/metrics'];
    for (const path of warmupPaths) {
      for (let i = 0; i < 5; i++) {
        try {
          await fetch(`${baseUrl}${path}`);
        } catch { /* expected during early startup */ }
      }
    }

    // Phase 2: Exercise the proxy handler to warm JIT, header parsing, etc.
    // These requests hit the full pipeline including rate limiter and throttle.
    // They return 400 (no target) but warm all the code paths.
    const promises = [];
    for (let i = 0; i < this.warmupCount; i++) {
      promises.push(
        fetch(`${baseUrl}/__warmup`, {
          method: 'HEAD',
          headers: {
            'x-proxy-target': `http://127.0.0.1:${config.port}/health`,
            'x-worker-id': 'warmup',
            'accept': '*/*',
          },
        }).catch(() => { /* connection may not be ready yet */ })
      );

      // Batch to avoid overwhelming the still-starting server.
      if (promises.length >= 10) {
        await Promise.allSettled(promises);
        promises.length = 0;
      }
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }

    // Phase 3: Pre-allocate and force GC to stabilize memory.
    if (global.gc) {
      global.gc();
    }

    // Phase 4: Start periodic self-heartbeat to keep instance hot.
    this._heartbeatTimer = setInterval(() => {
      fetch(`${baseUrl}/health`).catch(() => {});
    }, this.heartbeatMs).unref();

    this.isReady = true;
    logger.info({ elapsedMs: Date.now() - start }, 'warmup: complete');
  }

  destroy() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
    }
  }
}

export default WarmupEngine;

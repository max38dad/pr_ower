// ── Warmup Engine ──
// Pre-initializes connections, warms DNS cache, and runs synthetic traffic.
// Critical for edge containers where cold start = dropped requests.

import { request } from 'undici';
import { config } from './config.js';

export class WarmupEngine {
  constructor(proxyEngine) {
    this.proxy = proxyEngine;
    this.enabled = config.warmup.enabled;
    this.hosts = config.warmup.hosts;
    this.connectionsPerHost = config.warmup.connectionsPerHost;
    this.heartbeatMs = config.warmup.heartbeatIntervalMs;
    this.syntheticRequests = config.warmup.syntheticRequests;
    this.isReady = false;
    this._warmupDone = false;
  }

  /**
   * Execute full warmup sequence:
   *   1. DNS resolution for configured hosts
   *   2. Pre-establish connections via HEAD requests
   *   3. Run synthetic traffic to warm JIT, caches, etc.
   *   4. Start periodic heartbeat to keep connections hot
   */
  async execute() {
    if (!this.enabled) {
      this.isReady = true;
      this._warmupDone = true;
      return;
    }

    const logger = globalThis.__gatewayLogger || console;
    logger.info({ hosts: this.hosts.length }, 'warmup: starting');

    const start = Date.now();

    // Phase 1: DNS warmup + connection pre-init.
    if (this.hosts.length > 0) {
      await this._warmConnections();
    }

    // Phase 2: Synthetic traffic (self-requests).
    await this._runSyntheticTraffic();

    // Phase 3: Start heartbeat interval.
    if (this.hosts.length > 0) {
      this._heartbeatTimer = setInterval(
        () => this._heartbeat(),
        this.heartbeatMs
      ).unref();
    }

    this.isReady = true;
    this._warmupDone = true;

    const elapsed = Date.now() - start;
    logger.info({ elapsedMs: elapsed }, 'warmup: complete');
  }

  /**
   * Pre-establish connections to each configured host.
   * Uses HEAD requests to trigger TCP + TLS handshake + DNS resolution.
   */
  async _warmConnections() {
    const logger = globalThis.__gatewayLogger || console;
    const promises = [];

    for (const host of this.hosts) {
      for (let i = 0; i < this.connectionsPerHost; i++) {
        promises.push(
          this._connect(host).catch(err =>
            logger.warn({ host, err: err.code }, 'warmup: connect failed')
          )
        );
      }
    }

    await Promise.allSettled(promises);
  }

  async _connect(host) {
    // HEAD request: warm DNS, TCP, TLS without downloading a body.
    await request(host, {
      method: 'HEAD',
      dispatcher: this.proxy.agent,
    });
  }

  /**
   * Send synthetic requests through the full proxy pipeline.
   * Warms: route handlers, JIT compilation, internal caches, garbage collector.
   */
  async _runSyntheticTraffic() {
    if (this.syntheticRequests <= 0) return;

    const logger = globalThis.__gatewayLogger || console;
    const target = this.hosts[0];
    if (!target) return;

    const batchSize = Math.min(this.syntheticRequests, 10);
    const promises = [];

    for (let i = 0; i < this.syntheticRequests; i++) {
      promises.push(
        this._syntheticRequest(target).catch(() => { /* expected; target may not respond to HEAD */ })
      );

      if (promises.length >= batchSize) {
        await Promise.allSettled(promises);
        promises.length = 0;
      }
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }

    logger.debug({ count: this.syntheticRequests }, 'warmup: synthetic traffic done');
  }

  async _syntheticRequest(target) {
    await this.proxy.forward(target, {
      headers: {
        'user-agent': 'proxy-gateway-warmup/1.0',
        'accept': '*/*',
      },
      method: 'HEAD',
      body: null,
      requestId: `warmup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  /**
   * Periodic heartbeat: keep a few connections alive to each host.
   */
  async _heartbeat() {
    const promises = this.hosts.map(host =>
      this._connect(host).catch(() => { /* silently ignore */ })
    );
    await Promise.allSettled(promises);
  }

  destroy() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
    }
  }
}

export default WarmupEngine;

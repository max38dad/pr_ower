// ── High-Performance Reverse Proxy Engine ──
// Uses undici Agent for connection pooling with keep-alive.
// Handles forwarding, retry, error classification, streaming.

import { Agent, request as undiciRequest } from 'undici';
import { config } from './config.js';

// ── Hop-by-hop headers to strip ──
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding',
  'upgrade', 'proxy-connection',
]);

// ── Internal headers (not forwarded) ──
const INTERNAL_HEADERS = new Set([
  'x-proxy-target', 'x-worker-id', 'x-affinity-key',
  'x-request-id', 'x-forwarded-for', 'x-forwarded-proto',
]);

// ── Retryable error codes ──
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
  'EPIPE', 'ERR_HTTP2_GOAWAY_SESSION', 'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);

// ── Retryable HTTP status codes ──
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class ProxyEngine {
  constructor() {
    const pc = config.proxy;

    // Global undici Agent — manages per-origin connection pools automatically.
    this.agent = new Agent({
      connections: pc.connectionsPerOrigin,
      pipelining: pc.pipelining,
      keepAliveTimeout: pc.keepAliveTimeout,
      keepAliveMaxTimeout: pc.keepAliveMaxTimeout,
      connectTimeout: pc.connectTimeout,
      bodyTimeout: pc.bodyTimeout,
      headersTimeout: pc.requestTimeout,
      autoSelectFamily: true,
    });

    this.maxRetries = pc.maxRetries;
    this.retryBackoff = pc.retryBackoffMs;
    this.retryBackoffMax = pc.retryBackoffMaxMs;
    this.maxRedirects = pc.maxRedirects;

    // Metrics counters.
    this.metrics = {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      retryCount: 0,
      activeRequests: 0,
    };
  }

  /**
   * Forward an incoming request to the target URL.
   *
   * @param {string} targetUrl - Full target URL (e.g., https://example.com/path)
   * @param {object} incomingHeaders - Headers from the client request
   * @param {string} method - HTTP method
   * @param {ReadableStream|null} body - Request body stream (null for GET)
   * @param {string} requestId - Unique request ID for tracing
   * @returns {Promise<{status, headers, body: ReadableStream, requestId}>}
   */
  async forward(targetUrl, { headers: incomingHeaders = {}, method = 'GET', body = null, requestId = '' } = {}) {
    const cleanHeaders = this._sanitizeHeaders(incomingHeaders, requestId);

    // Add X-Forwarded-For from the original client.
    if (!cleanHeaders['x-forwarded-for']) {
      cleanHeaders['x-forwarded-for'] = requestId;
    }

    this.metrics.totalRequests++;
    this.metrics.activeRequests++;

    try {
      const result = await this._requestWithRetry(
        targetUrl, { method, headers: cleanHeaders, body }, 0
      );
      this.metrics.successCount++;
      return result;
    } catch (err) {
      this.metrics.errorCount++;
      throw err;
    } finally {
      this.metrics.activeRequests--;
    }
  }

  /**
   * Execute request with exponential backoff retry.
   */
  async _requestWithRetry(targetUrl, opts, attempt) {
    try {
      const response = await undiciRequest(targetUrl, {
        method: opts.method,
        headers: opts.headers,
        body: opts.body,
        dispatcher: this.agent,
        maxRedirections: this.maxRedirects,
        signal: opts.signal,
      });

      // Retry on server errors if we have attempts left.
      if (RETRYABLE_STATUS.has(response.statusCode) && attempt < this.maxRetries) {
        // Drain/destroy the body before retrying.
        try { response.body?.destroy(); } catch (_) { /* ignore */ }
        return this._retry(targetUrl, opts, attempt, `HTTP ${response.statusCode}`);
      }

      return {
        status: response.statusCode,
        headers: response.headers,
        body: response.body,
        requestId: opts.headers['x-request-id'] || '',
      };
    } catch (err) {
      if (!this._isRetryable(err) || attempt >= this.maxRetries) {
        throw err;
      }
      return this._retry(targetUrl, opts, attempt, err.code || err.message);
    }
  }

  async _retry(targetUrl, opts, attempt, reason) {
    this.metrics.retryCount++;

    // Exponential backoff with full jitter.
    const base = Math.min(
      this.retryBackoff * Math.pow(2, attempt),
      this.retryBackoffMax
    );
    const jitter = Math.random() * base;
    await new Promise(r => setTimeout(r, jitter));

    return this._requestWithRetry(targetUrl, opts, attempt + 1);
  }

  /**
   * Classify whether an error is retryable.
   */
  _isRetryable(err) {
    if (!err) return false;
    return RETRYABLE_CODES.has(err.code) || RETRYABLE_CODES.has(err.name);
  }

  /**
   * Clean headers: strip hop-by-hop + internal, rebuild as plain object.
   */
  _sanitizeHeaders(incomingHeaders, requestId) {
    const out = {};

    for (const [key, value] of Object.entries(incomingHeaders)) {
      const lower = key.toLowerCase();
      if (HOP_HEADERS.has(lower)) continue;
      if (INTERNAL_HEADERS.has(lower)) continue;
      // Skip undici/fastify internal headers.
      if (lower.startsWith(':') || lower === 'host') continue;
      out[key] = value;
    }

    out['x-request-id'] = requestId;
    out['accept-encoding'] = 'gzip, deflate, br';

    return out;
  }

  /**
   * Parse the target URL from request headers or query.
   * Supports:
   *   - X-Proxy-Target header (preferred)
   *   - ?url= query param
   *   - Load-balanced backend (configured in env)
   */
  static extractTarget(headers, query, loadBalancer) {
    // 1. Explicit target header.
    let target = headers['x-proxy-target'];
    if (target) return target;

    // 2. URL query param fallback.
    if (query && query.url) {
      return query.url;
    }

    // 3. Load-balanced backend.
    if (loadBalancer && loadBalancer.ready) {
      const affinityKey = headers['x-affinity-key'] || null;
      return loadBalancer.pick(affinityKey);
    }

    return null;
  }

  get poolStats() {
    return this.agent.stats ? this.agent.stats() : {};
  }

  async destroy() {
    await this.agent.destroy();
  }
}

export default ProxyEngine;

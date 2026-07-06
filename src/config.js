// ── Proxy Gateway Configuration ──
// All values can be overridden via environment variables.
// Defaults tuned for ~10,000 RPS sustained across the cluster.

const toInt = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? d : n;
};

const toFloat = (v, d) => {
  const n = parseFloat(v);
  return Number.isNaN(n) ? d : n;
};

const toBool = (v, d) => {
  if (v === undefined || v === null) return d;
  return v !== 'false' && v !== '0' && v !== '';
};

const toList = (v) => (v || '').split(',').map(s => s.trim()).filter(Boolean);

export const config = {
  // ── Server ──
  port: toInt(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',
  serverTimeout: toInt(process.env.SERVER_TIMEOUT_MS, 60_000),

  // ── Rate Limiter (token bucket per worker / IP) ──
  // Key priority: X-Worker-ID header > source IP.
  // With 200 Go workers, use X-Worker-ID so each worker gets its own bucket.
  // Default: 1000 req/sec per worker — 10x headroom for 50 RPS/worker at 10K total.
  rateLimit: {
    enabled: toBool(process.env.RATE_LIMIT_ENABLED, true),
    tokensPerSecond: toFloat(process.env.RATE_LIMIT_RPS, 1_000),
    burst: toInt(process.env.RATE_LIMIT_BURST, 2_000),
    maxBuckets: toInt(process.env.RATE_LIMIT_MAX_BUCKETS, 50_000),
    cleanupIntervalMs: toInt(process.env.RATE_LIMIT_CLEANUP_MS, 60_000),
    bucketTTLMs: toInt(process.env.RATE_LIMIT_BUCKET_TTL_MS, 300_000),
  },

  // ── Proxy Engine (undici Agent) ──
  // Per-origin connection pool. At 10K RPS with ~200ms avg response time
  // across 50 instances: 200 RPS/instance × 0.2s = 40 concurrent per origin.
  // 512 connections gives >10x headroom for bursts.
  proxy: {
    connectionsPerOrigin: toInt(process.env.PROXY_CONNECTIONS, 512),
    pipelining: toInt(process.env.PROXY_PIPELINING, 1),
    keepAliveTimeout: toInt(process.env.PROXY_KEEPALIVE_MS, 30_000),
    keepAliveMaxTimeout: toInt(process.env.PROXY_KEEPALIVE_MAX_MS, 300_000),
    connectTimeout: toInt(process.env.PROXY_CONNECT_TIMEOUT_MS, 5_000),
    requestTimeout: toInt(process.env.PROXY_REQUEST_TIMEOUT_MS, 25_000),
    bodyTimeout: toInt(process.env.PROXY_BODY_TIMEOUT_MS, 25_000),
    maxRetries: toInt(process.env.PROXY_MAX_RETRIES, 2),
    retryBackoffMs: toInt(process.env.PROXY_RETRY_BACKOFF_MS, 50),
    retryBackoffMaxMs: toInt(process.env.PROXY_RETRY_BACKOFF_MAX_MS, 3_000),
    maxRedirects: toInt(process.env.PROXY_MAX_REDIRECTS, 5),
  },

  // ── Adaptive Throttle ──
  // Event-loop lag monitor. At 10K RPS, the event loop is the bottleneck.
  // Throttle kicks in at 30ms lag to prevent cascading slowdown.
  // maxConcurrency=15000 allows 10K concurrent with 50% headroom.
  throttle: {
    enabled: toBool(process.env.THROTTLE_ENABLED, true),
    maxEventLoopLagMs: toFloat(process.env.THROTTLE_MAX_LAG_MS, 30),
    maxConcurrency: toInt(process.env.THROTTLE_MAX_CONCURRENCY, 15_000),
    minConcurrency: toInt(process.env.THROTTLE_MIN_CONCURRENCY, 500),
    checkIntervalMs: toInt(process.env.THROTTLE_CHECK_MS, 500),
    decayFactor: toFloat(process.env.THROTTLE_DECAY, 0.8),
  },

  // ── Warmup ──
  // Self-warming: synthetic requests through own pipeline.
  // No external hosts needed — warms JIT, route handlers, GC.
  warmup: {
    enabled: toBool(process.env.WARMUP_ENABLED, true),
    warmupCount: toInt(process.env.WARMUP_COUNT, 50),
    heartbeatIntervalMs: toInt(process.env.WARMUP_HEARTBEAT_MS, 20_000),
  },

  // ── Load-Balanced Backends (comma-separated URLs) ──
  // When configured, requests without X-Proxy-Target will be round-robined.
  backends: toList(process.env.BACKENDS),

  // ── Logging ──
  logLevel: process.env.LOG_LEVEL || 'info',
};

export default config;

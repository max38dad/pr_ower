// ── Fastify Server Setup ──
// Configures the HTTP server with all routes, hooks, and middleware.
// Optimized for >10,000 RPS on Bunny Magic Containers.

import Fastify from 'fastify';
import { config } from './config.js';
import { ProxyEngine } from './proxy.js';
import { RateLimiter } from './rate-limiter.js';
import { AdaptiveThrottle } from './adaptive-throttle.js';
import { WarmupEngine } from './warmup.js';
import { LoadBalancer } from './load-balancer.js';
import {
  registerServices,
  healthHandler,
  readinessHandler,
  metricsHandler,
} from './health.js';

// Paths that bypass rate limiting and throttle (internal health checks).
const BYPASS_PATHS = new Set(['/health', '/healthz', '/ready', '/metrics', '/warmup']);

export async function buildServer() {
  // ── Fastify instance ──
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    trustProxy: true,
    disableRequestLogging: true,

    // ── Tuning for 10K+ RPS ──
    maxParamLength: 128,
    connectionTimeout: 30_000,
    keepAliveTimeout: 65_000,
    requestTimeout: 60_000,
    bodyLimit: 10 * 1024 * 1024,           // 10 MB max body
    maxRequestsPerSocket: 0,               // unlimited — keep-alive forever
    // Fastify defaults to 1M max listeners; leave default.
    genReqId: () => crypto.randomUUID(),
  });

  // Expose logger globally for warmup engine.
  globalThis.__gatewayLogger = fastify.log;

  // ── Raw body pass-through ──
  // Register buffer parsers for common content types. Fastify's default JSON
  // parser may still run first, but we read raw body directly from the stream
  // in the proxy handler, completely bypassing Fastify's parser.
  for (const ct of ['application/json', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '*']) {
    fastify.addContentTypeParser(ct, { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  }

  // ── Core Services ──
  const proxyEngine = new ProxyEngine();
  const rateLimiter = new RateLimiter();
  const adaptiveThrottle = new AdaptiveThrottle();
  const loadBalancer = new LoadBalancer();
  const warmupEngine = new WarmupEngine(proxyEngine);

  registerServices({
    proxy: proxyEngine,
    limiter: rateLimiter,
    throttle: adaptiveThrottle,
    warmup: warmupEngine,
    balancer: loadBalancer,
  });

  // ── Lifecycle Hooks ──

  fastify.addHook('onReady', async () => {
    await warmupEngine.execute();
    fastify.log.info(
      { port: config.port, backends: loadBalancer.getBackendCount() },
      'gateway ready'
    );
  });

  fastify.addHook('onClose', async () => {
    fastify.log.info('shutting down...');
    rateLimiter.destroy();
    adaptiveThrottle.destroy();
    warmupEngine.destroy();
    await proxyEngine.destroy();
    fastify.log.info('stopped');
  });

  // ── Request Hook: Rate Limiting ──
  fastify.addHook('onRequest', async (request, reply) => {
    // Bypass for health/warmup endpoints.
    if (BYPASS_PATHS.has(request.url)) return;

    // Key priority: X-Worker-ID (each Go worker gets its own bucket).
    // Fallback: source IP.
    const workerId = request.headers['x-worker-id'];
    const key = workerId ? `worker:${workerId}` : request.ip;

    const result = rateLimiter.check(key);
    if (!result.allowed) {
      reply
        .code(429)
        .header('retry-after', String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
      throw fastify.httpErrors.tooManyRequests('rate limited');
    }
  });

  // ── Request Hook: Adaptive Throttling ──
  fastify.addHook('onRequest', async (request, reply) => {
    if (BYPASS_PATHS.has(request.url)) return;

    if (!adaptiveThrottle.acquire()) {
      reply.code(503).header('retry-after', '1');
      throw fastify.httpErrors.serviceUnavailable('backpressure');
    }
  });

  // Release throttle slot when response completes.
  fastify.addHook('onResponse', (_request, _reply, done) => {
    adaptiveThrottle.release();
    done();
  });

  // Release on error too. Double-release is safe (guarded internally).
  fastify.addHook('onError', (_request, _reply, _error, done) => {
    adaptiveThrottle.release();
    done();
  });

  // ── Routes ──

  fastify.get('/health', healthHandler);
  fastify.get('/healthz', healthHandler);  // Go BunnyProxyTransport warmup expects this
  fastify.get('/ready', readinessHandler);
  fastify.get('/metrics', metricsHandler);

  fastify.get('/warmup', async (_req, reply) => {
    reply.code(200).send({ status: 'warmed', ready: warmupEngine.isReady });
  });

  // ── Main Proxy Handler ──
  fastify.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
    url: '/*',
    handler: async (request, reply) => {
      const target = ProxyEngine.extractTarget(
        request.headers,
        request.query,
        loadBalancer
      );

      if (!target) {
        return reply.code(400).send({
          error: 'no_target',
          message: 'Provide X-Proxy-Target header, ?url= query param, or configure BACKENDS.',
        });
      }

      // Validate URL.
      try {
        new URL(target);
      } catch {
        return reply.code(400).send({ error: 'invalid_target_url', target });
      }

      const method = request.method;
      const requestId = request.id;

      // Body forwarding: read directly from raw Node.js stream.
      // This bypasses Fastify's content-type parser entirely, so we never
      // hit FST_ERR_CTP_INVALID_JSON_BODY even if the default parser is active.
      const hasBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
      let body = null;
      if (hasBody) {
        try {
          const raw = request.raw; // Node.js IncomingMessage — still has data if request.body wasn't accessed
          const chunks = [];
          for await (const chunk of raw) {
            chunks.push(chunk);
          }
          if (chunks.length > 0) body = Buffer.concat(chunks);
        } catch { /* empty */ }
      }

      let result;
      try {
        result = await proxyEngine.forward(target, {
          headers: request.headers,
          method,
          body,
          requestId,
        });
      } catch (err) {
        const code = err.code || '';
        const status =
          code === 'ECONNREFUSED' ? 502
          : code === 'ETIMEDOUT' ? 504
          : err.statusCode >= 400 ? err.statusCode
          : 502;

        request.log.warn(
          { target, method, err: err.message, code: err.code, status },
          'proxy error'
        );

        return reply.code(status).send({
          error: 'proxy_error',
          message: err.message,
          code: err.code,
        });
      }

      // If the client already disconnected, destroy the upstream body and bail.
      if (request.raw.destroyed) {
        result.body?.destroy();
        return;
      }

      // When the client disconnects mid-stream, abort the upstream.
      request.raw.once('close', () => {
        result.body?.destroy();
      });

      reply.code(result.status);

      // Forward response headers (strip hop-by-hop).
      if (result.headers) {
        for (const [key, value] of Object.entries(result.headers)) {
          const lower = key.toLowerCase();
          if (
            lower === 'connection' ||
            lower === 'keep-alive' ||
            lower === 'transfer-encoding' ||
            lower === 'content-length'
          ) continue;
          reply.header(key, value);
        }
      }

      // Pipe response body as stream — zero buffering.
      // reply.send() may throw AbortError if client disconnected; catch it.
      try {
        return result.body ? reply.send(result.body) : reply.send();
      } catch (err) {
        result.body?.destroy();
        return;
      }
    },
  });

  // ── Global Error Handler ──
  fastify.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;

    const statusCode = error.statusCode || 500;

    request.log.warn(
      { err: error.message, statusCode, url: request.url },
      'error'
    );

    reply.code(statusCode).send({
      error: error.code || 'internal_error',
      message: statusCode === 500 ? 'internal server error' : error.message,
    });
  });

  return { fastify, proxyEngine, rateLimiter, adaptiveThrottle, warmupEngine, loadBalancer };
}

export default buildServer;

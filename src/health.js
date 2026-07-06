// ── Health & Observability Endpoints ──
// /health  — liveness probe (is the process alive?)
// /ready   — readiness probe (is the instance accepting traffic?)
// /metrics — Prometheus-compatible metrics dump

import { config } from './config.js';

// Singleton references set by server.js on startup.
let proxyEngine = null;
let rateLimiter = null;
let adaptiveThrottle = null;
let warmupEngine = null;
let loadBalancer = null;
let startTime = Date.now();

export function registerServices({ proxy, limiter, throttle, warmup, balancer }) {
  proxyEngine = proxy;
  rateLimiter = limiter;
  adaptiveThrottle = throttle;
  warmupEngine = warmup;
  loadBalancer = balancer;
  startTime = Date.now();
}

/**
 * Liveness: always returns 200 if the process is running.
 */
export function healthHandler(_req, reply) {
  reply.code(200).send({ status: 'ok', uptime: process.uptime() });
}

/**
 * Readiness: returns 200 only when warmup is complete and all services ready.
 * Bunny edge uses this to determine when to route traffic to this instance.
 */
export function readinessHandler(_req, reply) {
  const warmupReady = !warmupEngine || warmupEngine.isReady;
  const proxyReady = !!proxyEngine;

  if (warmupReady && proxyReady) {
    reply.code(200).send({ status: 'ready' });
  } else {
    reply.code(503).send({
      status: 'not_ready',
      warmup: warmupReady,
      proxy: proxyReady,
    });
  }
}

/**
 * Metrics endpoint: exposes key performance indicators.
 * Returns JSON for simplicity; can be scraped by monitoring.
 */
export function metricsHandler(_req, reply) {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  const payload = {
    uptime: process.uptime(),
    memory: {
      rssMB: Math.round(mem.rss / 1024 / 1024),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      externalMB: Math.round(mem.external / 1024 / 1024),
    },
    cpu: {
      userMs: Math.round(cpu.user / 1000),
      systemMs: Math.round(cpu.system / 1000),
    },
    proxy: proxyEngine ? proxyEngine.metrics : {},
    throttle: adaptiveThrottle ? adaptiveThrottle.metrics : {},
    rateLimiter: rateLimiter ? { size: rateLimiter.size, enabled: rateLimiter.enabled } : {},
    loadBalancer: loadBalancer
      ? { backends: loadBalancer.getBackendCount(), ready: loadBalancer.ready }
      : {},
    nodeVersion: process.version,
  };

  reply.code(200).send(payload);
}

export default { registerServices, healthHandler, readinessHandler, metricsHandler };

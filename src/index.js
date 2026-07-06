// ── Proxy Gateway Entry Point ──
// Bootstraps the server and handles OS signals for graceful shutdown.
// Designed for Bunny Magic Containers edge runtime.

import { config } from './config.js';
import { buildServer } from './server.js';

// ── Startup memory report (helps debug OOM) ──
function logMemory(tag) {
  const mem = process.memoryUsage();
  console.log(
    `[MEM ${tag}] rss=${Math.round(mem.rss / 1024 / 1024)}MB ` +
    `heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB ` +
    `external=${Math.round(mem.external / 1024 / 1024)}MB`
  );
}

// ── Uncaught Error Handling ──
// AbortError = client disconnected mid-response. Normal under load, do NOT crash.
const NON_FATAL = new Set(['AbortError', 'ERR_STREAM_PREMATURE_CLOSE']);

process.on('uncaughtException', (err) => {
  if (NON_FATAL.has(err.name)) {
    console.error('[WARN] non-fatal:', err.name, err.message);
    return;
  }
  console.error('[FATAL] uncaughtException:', err.message);
  console.error(err.stack);
  setTimeout(() => process.exit(1), 500).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

// ── Graceful Shutdown ──
async function gracefulShutdown(signal, fastify) {
  console.log(`[SHUTDOWN] ${signal}, draining...`);
  try {
    await fastify.close();
    console.log('[SHUTDOWN] complete');
  } catch (err) {
    console.error('[SHUTDOWN] error:', err.message);
  }
  process.exit(0);
}

// ── Bootstrap ──
async function main() {
  console.log(`[BOOT] Node.js ${process.version} | pid=${process.pid}`);
  console.log(`[BOOT] port=${config.port} | throttling=${config.throttle.enabled} | rate_limit=${config.rateLimit.enabled}`);
  logMemory('boot-start');

  let fastify;
  try {
    const server = await buildServer();
    fastify = server.fastify;
  } catch (err) {
    console.error('[FATAL] buildServer failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }

  logMemory('boot-built');

  // Wire OS signals.
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM', fastify));
  process.once('SIGINT', () => gracefulShutdown('SIGINT', fastify));

  try {
    await fastify.listen({ port: config.port, host: config.host });
  } catch (err) {
    console.error('[FATAL] listen failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  }

  logMemory('boot-listening');
  console.log('[BOOT] server listening — ready for traffic');
}

main();

// ── Proxy Gateway Entry Point ──
// Bootstraps the server and handles OS signals for graceful shutdown.
// Designed for Bunny Magic Containers edge runtime.

import { config } from './config.js';
import { buildServer } from './server.js';

// ── Uncaught Error Handling ──
// Catch-all to prevent crashes from taking down the container.
// Log and let the orchestrator restart if needed.

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  // Give time for logs to flush, then exit so the orchestrator restarts.
  setTimeout(() => process.exit(1), 1000).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
});

// ── Graceful Shutdown ──
// Bunny edge sends SIGTERM before killing the container.
// We drain in-flight requests before exiting.

async function gracefulShutdown(signal, fastify) {
  console.log(`[SHUTDOWN] received ${signal}, draining...`);

  // Stop accepting new requests.
  try {
    await fastify.close();
  } catch (err) {
    console.error('[SHUTDOWN] close error:', err);
    process.exit(1);
  }

  console.log('[SHUTDOWN] complete');
  process.exit(0);
}

// ── Bootstrap ──

async function main() {
  console.log(`[BOOT] Node.js ${process.version}`);
  console.log(`[BOOT] Config: port=${config.port}, backends=${config.backends.length}, throttle=${config.throttle.enabled}`);

  const { fastify } = await buildServer();

  // Wire OS signals.
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM', fastify));
  process.once('SIGINT', () => gracefulShutdown('SIGINT', fastify));

  try {
    await fastify.listen({ port: config.port, host: config.host });
  } catch (err) {
    console.error('[FATAL] Failed to start server:', err);
    process.exit(1);
  }
}

main();

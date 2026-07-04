const express = require("express");

const APP_PORT = Number(process.env.PORT || 8080);
const TARGET_HEADER = "x-target-url";
const TIMEOUT_HEADER = "x-proxy-timeout";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_MB = 2;
const VERIFY_TLS = false;

if (!VERIFY_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ============================================================
// Auto-scaling resilience — retry + backoff for cold targets
// ============================================================
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 300;  // base delay, doubles each retry
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const CIRCUIT_HALF_OPEN_MS = 15000; // 15 sec before retrying a dead host
const CIRCUIT_FAIL_THRESHOLD = 5;   // consecutive failures to open circuit

// Per-host circuit breaker state
const circuitState = new Map(); // host -> { failures: number, openUntil: timestamp }

function isCircuitOpen(host) {
  const state = circuitState.get(host);
  if (!state) return false;
  if (state.openUntil > Date.now()) return true;
  // Half-open: allow one probe
  circuitState.delete(host);
  return false;
}

function recordCircuitFailure(host) {
  let state = circuitState.get(host);
  if (!state) {
    state = { failures: 0, openUntil: 0 };
    circuitState.set(host, state);
  }
  state.failures++;
  if (state.failures >= CIRCUIT_FAIL_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_HALF_OPEN_MS;
  }
}

function recordCircuitSuccess(host) {
  circuitState.delete(host);
}

// Periodic cleanup of old circuit entries
setInterval(() => {
  const now = Date.now();
  for (const [host, state] of circuitState) {
    if (state.openUntil < now) circuitState.delete(host);
  }
}, 60000);

// ============================================================
// Keep-Alive Agent — reuse TCP+TLS connections to targets.
// Without this, every request does a new handshake (150-300ms extra).
// This is THE #1 fix for proxy throughput.
// ============================================================
const http = require("http");
const https = require("https");

const keepAliveAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 30000,
  rejectUnauthorized: VERIFY_TLS,
});

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 30000,
});

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REQUEST_HEADERS_TO_DROP = new Set([
  "host",
  "content-length",
  TARGET_HEADER,
  TIMEOUT_HEADER,
  "x-real-ip",
  "true-client-ip",
  "cf-connecting-ip",
]);

const RESPONSE_HEADERS_TO_DROP = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
]);

const app = express();
app.disable("x-powered-by");
app.use(express.raw({ type: "*/*", limit: `${MAX_BODY_MB}mb` }));

// ============================================================
// Health check — Bunny CDN uses this for readiness probes
// CRITICAL for auto-scaling: responds immediately so Bunny
// knows the container is ready to receive traffic.
// ============================================================
app.get("/healthz", (_req, res) => {
  res.status(200).send("OK");
});

function filterRequestHeaders(headers) {
  const forwarded = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(normalized)) continue;
    if (REQUEST_HEADERS_TO_DROP.has(normalized)) continue;
    if (normalized.startsWith("x-forwarded-")) continue;
    if (normalized.startsWith("cdn-")) continue;
    if (typeof value === "undefined") continue;

    forwarded[key] = value;
  }

  return forwarded;
}

function applyResponseHeaders(res, headers) {
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (RESPONSE_HEADERS_TO_DROP.has(normalized)) continue;
    res.setHeader(key, value);
  }
}

function requestMeta(req) {
  return {
    method: req.method,
    path: req.originalUrl,
    remote_addr: req.headers["x-forwarded-for"] || req.socket.remoteAddress || null,
  };
}

function resolveTimeoutMs(req) {
  const headerValue = String(req.headers[TIMEOUT_HEADER] || "").trim();
  if (!headerValue) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.round(parsed * 1000));
}

function withTimeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

function extractHost(urlString) {
  try {
    return new URL(urlString).host;
  } catch {
    return null;
  }
}

// ============================================================
// Core proxy with retry + circuit breaker
// ============================================================
async function proxyRequest(targetUrl, req, timeoutMs) {
  const host = extractHost(targetUrl);

  // Circuit breaker check
  if (host && isCircuitOpen(host)) {
    const err = new Error(`Circuit open for ${host}`);
    err.status = 503;
    err.circuitOpen = true;
    throw err;
  }

  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: filterRequestHeaders(req.headers),
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        redirect: "manual",
        signal: withTimeoutSignal(timeoutMs),
        // Use keep-alive agent: reuses TCP+TLS connections, eliminates handshake overhead
        agent: targetUrl.startsWith("https") ? keepAliveAgent : httpAgent,
      });

      // If the response is a server error, retry with backoff
      if (RETRYABLE_STATUSES.has(response.status)) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          lastError = new Error(`Target returned ${response.status}`);
          continue;
        }
        // Last attempt — return the error response as-is
        if (host) recordCircuitFailure(host);
      }

      // Success
      if (host) recordCircuitSuccess(host);
      return response;

    } catch (fetchError) {
      lastError = fetchError;

      // Don't retry on AbortError (timeout from our side)
      if (fetchError.name === "AbortError") {
        break;
      }

      // Retry on network errors
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  // All retries exhausted
  if (host) recordCircuitFailure(host);
  throw lastError;
}

async function getPublicIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", {
      method: "GET",
      signal: withTimeoutSignal(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) return "Sconosciuto";
    const payload = await response.json();
    return payload && payload.ip ? String(payload.ip) : "Sconosciuto";
  } catch {
    return "Sconosciuto";
  }
}

async function containerInfo(req) {
  return {
    message: "Bunny CDN Magic Container Proxy is Running!",
    container_ip: await getPublicIp(),
    headers_received: req.headers,
  };
}

// ============================================================
// Main route handler
// ============================================================
app.all(["/", "/:path(*)"], async (req, res) => {
  const targetUrl = String(req.headers[TARGET_HEADER] || "").trim();

  if (!targetUrl) {
    return res.status(200).json(await containerInfo(req));
  }

  try {
    const timeoutMs = resolveTimeoutMs(req);
    const upstreamResponse = await proxyRequest(targetUrl, req, timeoutMs);

    applyResponseHeaders(res, upstreamResponse.headers);
    res.status(upstreamResponse.status);

    if (!upstreamResponse.body) {
      return res.end();
    }

    // Stream the response instead of buffering — eliminates memory + latency overhead.
    // ReadableStream (fetch) → Node.js Readable → Express res (writable)
    const { Readable } = require("stream");
    const nodeStream = Readable.fromWeb(upstreamResponse.body);
    nodeStream.pipe(res);
    nodeStream.on("error", () => { if (!res.headersSent) res.status(502).end("Proxy stream error"); });
    return;
  } catch (error) {
    // Distinguish error types for better scanner feedback
    const isTimeout = error.name === "AbortError";
    const isCircuitOpen = error.circuitOpen === true;

    if (isCircuitOpen) {
      // 503 = service unavailable, scanner knows it's temporary
      return res.status(503).send("Proxy temporaneamente non disponibile (circuit breaker attivo)");
    }

    if (isTimeout) {
      return res.status(504).send(`Timeout nel proxy (${resolveTimeoutMs(req)}ms)`);
    }

    const errorMessage = String(error && error.message ? error.message : error);
    return res.status(502).send(`Errore nel proxy: ${errorMessage}`);
  }
});

app.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`bunny proxy listening on ${APP_PORT} (retry=${MAX_RETRIES}, circuit_fail=${CIRCUIT_FAIL_THRESHOLD})`);
});

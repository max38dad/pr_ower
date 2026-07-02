const express = require("express");

const APP_PORT = Number(process.env.PORT || 8080);
const TARGET_HEADER = "x-target-url";
const CONNECT_TIMEOUT_MS = Number(process.env.PROXY_CONNECT_TIMEOUT || 5000);
const READ_TIMEOUT_MS = Number(process.env.PROXY_READ_TIMEOUT || 20000);

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
app.use(express.raw({ type: "*/*", limit: "25mb" }));

function filterRequestHeaders(headers) {
  const forwarded = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();

    if (HOP_BY_HOP_HEADERS.has(normalized)) {
      continue;
    }
    if (REQUEST_HEADERS_TO_DROP.has(normalized)) {
      continue;
    }
    if (normalized.startsWith("x-forwarded-")) {
      continue;
    }
    if (normalized.startsWith("cdn-")) {
      continue;
    }
    if (typeof value === "undefined") {
      continue;
    }

    forwarded[key] = value;
  }

  return forwarded;
}

function applyResponseHeaders(res, headers) {
  for (const [key, value] of headers.entries()) {
    const normalized = key.toLowerCase();
    if (RESPONSE_HEADERS_TO_DROP.has(normalized)) {
      continue;
    }
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

function withTimeoutSignal() {
  const timeoutMs = CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS;
  return AbortSignal.timeout(timeoutMs);
}

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

app.get("/ready", (req, res) => {
  res.status(200).json({
    ok: true,
    status: "ready",
    max_body_mb: 25,
    timeout_ms: CONNECT_TIMEOUT_MS + READ_TIMEOUT_MS,
  });
});

app.all(/.*/, async (req, res) => {
  const targetUrl = String(req.headers[TARGET_HEADER] || "").trim();

  if (!targetUrl) {
    return res.status(400).json({
      ok: false,
      error: "missing X-Target-Url header",
    });
  }

  try {
    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
      signal: withTimeoutSignal(),
    });

    applyResponseHeaders(res, upstreamResponse.headers);
    res.status(upstreamResponse.status);

    if (!upstreamResponse.body) {
      return res.end();
    }

    const arrayBuffer = await upstreamResponse.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    if (error && error.name === "TimeoutError") {
      return res.status(504).json({
        ok: false,
        error: "upstream timeout",
        meta: requestMeta(req),
      });
    }

    if (error && error.name === "AbortError") {
      return res.status(504).json({
        ok: false,
        error: "upstream aborted",
        meta: requestMeta(req),
      });
    }

    return res.status(502).json({
      ok: false,
      error: "upstream request failed",
      details: String(error && error.message ? error.message : error),
      meta: requestMeta(req),
    });
  }
});

app.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`bunny proxy listening on ${APP_PORT}`);
});

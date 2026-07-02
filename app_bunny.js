const express = require("express");
const { Agent } = require("undici");

const APP_PORT = Number(process.env.PORT || 8080);
const TARGET_HEADER = "x-target-url";
const TIMEOUT_HEADER = "x-proxy-timeout";
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_BODY_MB = 2;
const VERIFY_TLS = false;

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

const upstreamDispatcher = new Agent({
  connect: {
    rejectUnauthorized: VERIFY_TLS,
  },
});

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

function resolveTimeoutMs(req) {
  const headerValue = String(req.headers[TIMEOUT_HEADER] || "").trim();

  if (!headerValue) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.max(1, Math.round(parsed * 1000));
}

function withTimeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

async function getPublicIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", {
      method: "GET",
      signal: withTimeoutSignal(DEFAULT_TIMEOUT_MS),
      dispatcher: upstreamDispatcher,
    });
    if (!response.ok) {
      return "Sconosciuto";
    }
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

app.get("/healthz", (req, res) => {
  res.status(200).json({ ok: true, status: "healthy" });
});

app.get("/ready", (req, res) => {
  res.status(200).json({
    ok: true,
    status: "ready",
    max_body_mb: MAX_BODY_MB,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    tls_verify: VERIFY_TLS,
  });
});

app.all(["/", "/:path(*)"], async (req, res) => {
  const targetUrl = String(req.headers[TARGET_HEADER] || "").trim();

  if (!targetUrl) {
    return res.status(200).json(await containerInfo(req));
  }

  try {
    const timeoutMs = resolveTimeoutMs(req);
    const upstreamResponse = await fetch(targetUrl, {
      method: req.method,
      headers: filterRequestHeaders(req.headers),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
      signal: withTimeoutSignal(timeoutMs),
      dispatcher: upstreamDispatcher,
    });

    applyResponseHeaders(res, upstreamResponse.headers);
    res.status(upstreamResponse.status);

    if (!upstreamResponse.body) {
      return res.end();
    }

    const arrayBuffer = await upstreamResponse.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (error) {
    const errorMessage = String(error && error.message ? error.message : error);
    return res.status(500).send(`Errore nel proxy: ${errorMessage}`);
  }
});

app.listen(APP_PORT, "0.0.0.0", () => {
  console.log(`bunny proxy listening on ${APP_PORT}`);
});

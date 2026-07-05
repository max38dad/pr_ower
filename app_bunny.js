const http = require("http");
const PORT = process.env.PORT || 8080;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

http.createServer(async (req, res) => {
  // Bunny readiness probe
  if (req.url === "/healthz") {
    res.writeHead(200);
    return res.end("OK");
  }

  const target = req.headers["x-target-url"];
  if (!target) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, port: PORT }));
  }

  try {
    const ms = (Number(req.headers["x-proxy-timeout"]) || 5) * 1000;

    // clona headers escludendo quelli interni
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const n = k.toLowerCase();
      if (n === "host" || n === "x-target-url" || n === "x-proxy-timeout" || n === "connection") continue;
      h[k] = v;
    }

    const noBody = req.method === "GET" || req.method === "HEAD";
    const resp = await fetch(target, {
      method: req.method,
      headers: h,
      body: noBody ? undefined : req,
      signal: AbortSignal.timeout(ms),
    });

    // forward response headers
    const rh = {};
    for (const [k, v] of resp.headers) {
      const n = k.toLowerCase();
      if (n === "content-encoding" || n === "transfer-encoding" || n === "connection") continue;
      rh[k] = v;
    }
    res.writeHead(resp.status, rh);

    if (resp.body) {
      for await (const chunk of resp.body) res.write(chunk);
    }
    res.end();
  } catch (err) {
    res.writeHead(err.name === "AbortError" ? 504 : 502);
    res.end(err.message || "proxy error");
  }
}).listen(PORT, "0.0.0.0", () => console.log(`proxy ready :${PORT}`));

export const config = {
  runtime: "edge",
};

// ---------- Environment Variables ----------
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const RELAY_PATH = normalizeRelayPath(process.env.RELAY_PATH || "/xhttp-relay");
const RELAY_KEY = (process.env.RELAY_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = parsePositiveInt(process.env.UPSTREAM_TIMEOUT_MS, 60000, 1000);
const MAX_INFLIGHT = parsePositiveInt(process.env.MAX_INFLIGHT, 12, 1);
const FAKE_HEALTH_PATH = normalizeRelayPath(process.env.FAKE_HEALTH_PATH || "/health");
const JITTER_MS_MAX = parsePositiveInt(process.env.JITTER_MS_MAX, 0, 0);

// ---------- Constants ----------
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);
const STRIP_REQUEST_HEADERS = new Set([
  "host", "connection", "keep-alive", "proxy-authenticate",
  "proxy-authorization", "te", "trailer", "transfer-encoding",
  "upgrade", "forwarded", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port", "x-forwarded-for", "x-real-ip",
  "x-vercel-ip", "x-vercel-proxy-signature", "x-vercel-id",
  "x-vercel-proxied", "x-vercel-deployment-url", "x-vercel-country",
  "x-forwarded-for-vercel", "cf-connecting-ip", "cf-ipcountry",
  "cf-ray", "cf-visitor", "true-client-ip", "cdn-loop", "via",
  "proxy-connection",
]);
const STRIP_RESPONSE_HEADERS = new Set([
  "server", "x-powered-by", "x-vercel-cache", "x-vercel-id",
  "x-vercel-deployment-url", "cf-cache-status", "cf-ray",
  "report-to", "nel", "access-control-allow-origin",
  "access-control-allow-credentials",
]);
const FORWARD_HEADER_PREFIXES = [
  "accept", "content-", "user-agent", "cache-control",
  "pragma", "sec-ch-", "sec-fetch-", "sec-websocket-",
  "x-", "range", "if-", "referer", "origin", "cookie",
  "dnt", "authorization",
];

// ---------- Decoy HTML (Landing Page) - THE FIX IS HERE! ----------
const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A Man With Two Heads</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #0a0a0a;
    color: #ccc;
    font-family: 'Courier New', Courier, monospace;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 2rem;
    background-image: radial-gradient(circle at 20% 20%, #1a1a1a 0%, #0a0a0a 90%);
  }
  .card {
    max-width: 600px; width: 100%;
    background: #111; border: 1px solid #2a2a2a;
    border-radius: 16px; padding: 2.5rem;
    box-shadow: 0 0 30px rgba(255,0,0,0.1);
  }
  h1 {
    font-size: 2.2rem; text-align: center;
    background: linear-gradient(135deg, #e63946, #ff4d4d);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 1.5rem; letter-spacing: 2px;
    text-shadow: 0 0 8px rgba(230,57,70,0.5);
  }
  .status-line {
    display: flex; align-items: center; gap: 10px;
    justify-content: center; margin-bottom: 2rem;
  }
  .status-dot {
    width: 12px; height: 12px;
    background: #2ecc71; border-radius: 50%;
    box-shadow: 0 0 12px #2ecc71;
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse {
    0% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.5; transform: scale(1.1); }
    100% { opacity: 1; transform: scale(1); }
  }
  .status-text { font-size: 1rem; color: #2ecc71; }
  .quote {
    font-style: italic; text-align: center;
    padding: 1.2rem; border-left: 3px solid #e63946;
    background: rgba(230,57,70,0.05); margin: 1.5rem 0;
    color: #bbb;
  }
  .quote-author { display: block; margin-top: 0.5rem; color: #e63946; font-size: 0.9rem; }
  .info-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;
    margin-top: 1.5rem; font-size: 0.9rem;
  }
  .info-item {
    background: #191919; padding: 0.8rem; border-radius: 8px;
    border: 1px solid #2a2a2a;
  }
  .info-label { color: #888; font-size: 0.7rem; text-transform: uppercase; }
  .info-value { color: #e63946; font-weight: bold; }
  .footer-text { text-align: center; font-size: 0.75rem; color: #555; margin-top: 2rem; }
</style>
</head>
<body>
<div class="card">
  <h1>A Man With Two Heads</h1>
  <div class="status-line">
    <span class="status-dot"></span>
    <span class="status-text">Operational</span>
  </div>
  <div class="quote">
    “The eternal silence of these infinite spaces frightens me.”
    <span class="quote-author">— Blaise Pascal</span>
  </div>
  <div class="info-grid">
    <div class="info-item"><span class="info-label">Project</span><br><span class="info-value">Edge Relay</span></div>
    <div class="info-item"><span class="info-label">Environment</span><br><span class="info-value">Edge Network</span></div>
    <div class="info-item"><span class="info-label">Node</span><br><span class="info-value" id="nodeId">EU-WEST-1</span></div>
    <div class="info-item"><span class="info-label">Visitors</span><br><span class="info-value" id="visitorCount">1,337</span></div>
  </div>
  <div class="footer-text">&copy; 2025 – This is a decoy page.</div>
</div>
<script>
  (function() {
    var c = localStorage.getItem('vCounter');
    if (!c) { c = 1337 + Math.floor(Math.random() * 100); }
    c = parseInt(c) + 1;
    localStorage.setItem('vCounter', c);
    document.getElementById('visitorCount').textContent = c.toLocaleString();
    var regions = ['EU-WEST-1', 'US-EAST-2', 'AP-SOUTHEAST-1', 'SA-EAST-1'];
    document.getElementById('nodeId').textContent = regions[Math.floor(Math.random() * regions.length)];
  })();
</script>
</body>
</html>`;

// ---------- Helpers ----------
function normalizeRelayPath(raw) {
  if (!raw) return "/";
  let p = raw.startsWith("/") ? raw : `/${raw}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}
function parsePositiveInt(raw, fallback, min) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min) return fallback;
  return Math.trunc(v);
}
function tryAcquireSlot() { if (inFlight >= MAX_INFLIGHT) return false; inFlight++; return true; }
function releaseSlot() { inFlight = Math.max(0, inFlight - 1); }
function shouldForwardHeader(h) { for (const p of FORWARD_HEADER_PREFIXES) if (h.startsWith(p)) return true; return false; }
function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomDelay(max) { if (max <= 0) return; const ms = Math.floor(Math.random() * max) + 20; return new Promise(r => setTimeout(r, ms)); }

// ---------- Shared State ----------
let inFlight = 0;
const SERVER_NAMES = ["nginx", "Apache/2.4.41 (Ubuntu)", "LiteSpeed", "cloudflare", "Microsoft-IIS/10.0"];
const DECOY_404_HTML = `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body style="text-align:center;padding-top:50px;background:#0a0a0a;color:#ccc;font-family:monospace;"><h1>404</h1><p>Nothing to see here.</p></body></html>`;

const FAKE_HEALTH_JSON = JSON.stringify({
  status: "ok",
  uptime: Math.floor(Date.now() / 1000) % 86400,
  version: "2.1.3",
  timestamp: Date.now()
});

// ---------- Main Handler ----------
export default async function handler(req) {
  const startedAt = Date.now();
  let slotAcquired = false;
  const url = new URL(req.url);

  // ---- Landing Page ----
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return new Response(LANDING_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) }
    });
  }

  // ---- Fake Health ----
  if (url.pathname === FAKE_HEALTH_PATH) {
    return new Response(FAKE_HEALTH_JSON, {
      status: 200,
      headers: { "content-type": "application/json", "server": randomItem(SERVER_NAMES) }
    });
  }

  // ---- Missing Target ----
  if (!TARGET_BASE) {
    return new Response(DECOY_404_HTML, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) }
    });
  }

  // ---- Path Validation (Relay) ----
  if (!(url.pathname === RELAY_PATH || url.pathname.startsWith(RELAY_PATH + "/"))) {
    return new Response(DECOY_404_HTML, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) }
    });
  }

  // ---- Method ----
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ---- Auth (optional) ----
  if (RELAY_KEY) {
    const authToken = req.headers.get("x-relay-key") || "";
    if (authToken !== RELAY_KEY) {
      return new Response(DECOY_404_HTML, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) }
      });
    }
  }

  // ---- Concurrency ----
  if (!tryAcquireSlot()) {
    return new Response("Service Unavailable", { status: 503, headers: { "retry-after": "1" } });
  }
  slotAcquired = true;

  try {
    // Build target URL
    const targetUrl = `${TARGET_BASE}${url.pathname}${url.search}`;

    // Prepare request headers
    const headers = new Headers();
    let clientIp = null;
    for (const [key, value] of req.headers) {
      const lowerKey = key.toLowerCase();
      if (STRIP_REQUEST_HEADERS.has(lowerKey)) continue;
      if (lowerKey.startsWith("x-vercel-") || lowerKey.startsWith("cf-")) continue;
      if (lowerKey === "x-relay-key") continue;
      if (lowerKey === "x-real-ip" || lowerKey === "true-client-ip") {
        if (!clientIp && value) clientIp = value;
        continue;
      }
      if (!shouldForwardHeader(lowerKey)) continue;
      headers.set(key, value);
    }
    if (clientIp) headers.set("x-forwarded-for", clientIp);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", randomItem([
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
      ]));
    }

    // Optional jitter
    if (JITTER_MS_MAX > 0) await randomDelay(JITTER_MS_MAX);

    // Fetch upstream
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);
    const fetchOpts = {
      method: req.method,
      headers,
      redirect: "manual",
      signal: abortController.signal,
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = req.body;
      fetchOpts.duplex = "half";
    }
    let upstream;
    try {
      upstream = await fetch(targetUrl, fetchOpts);
    } finally {
      clearTimeout(timeoutId);
    }

    // Build response headers
    const responseHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lk = k.toLowerCase();
      if (lk === "transfer-encoding" || lk === "connection") continue;
      if (STRIP_RESPONSE_HEADERS.has(lk)) continue;
      if (lk.startsWith("x-vercel-") || lk.startsWith("cf-")) continue;
      responseHeaders.set(k, v);
    }
    responseHeaders.set("server", randomItem(SERVER_NAMES));
    if (Math.random() > 0.3) responseHeaders.set("x-content-type-options", "nosniff");
    if (Math.random() > 0.5) responseHeaders.set("x-frame-options", "SAMEORIGIN");

    if (process.env.ENABLE_LOGGING !== "0") {
      console.log(`[relay] ${req.method} ${url.pathname} -> ${upstream.status} (${Date.now() - startedAt}ms)`);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    if (process.env.ENABLE_LOGGING !== "0") console.error(`[relay] error: ${err.message}`);
    return new Response(err.name === "AbortError" ? "Gateway Timeout" : "Bad Gateway", {
      status: err.name === "AbortError" ? 504 : 502,
    });
  } finally {
    if (slotAcquired) releaseSlot();
  }
}

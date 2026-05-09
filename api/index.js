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
const JITTER_MS_MAX = parsePositiveInt(process.env.JITTER_MS_MAX, 0, 0); // پیش‌فرض غیرفعال

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
function tryAcquireSlot() {
  if (inFlight >= MAX_INFLIGHT) return false;
  inFlight++;
  return true;
}
function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1);
}
function shouldForwardHeader(h) {
  for (const prefix of FORWARD_HEADER_PREFIXES) {
    if (h.startsWith(prefix)) return true;
  }
  return false;
}
function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomDelay(max) {
  if (max <= 0) return;
  const ms = Math.floor(Math.random() * max) + 20;
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Shared State ----------
let inFlight = 0;
const SERVER_NAMES = [
  "nginx",
  "Apache/2.4.41 (Ubuntu)",
  "LiteSpeed",
  "cloudflare",
  "Microsoft-IIS/10.0",
];
const DECOY_404_TEMPLATES = [
  "<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>Not Found</h1><p>The requested URL was not found on this server.</p></body></html>",
  "<!DOCTYPE html><html><head><title>Page Not Found</title></head><body style='text-align:center;padding-top:50px;'><h2>404</h2><p>Oops! The page you're looking for doesn't exist.</p></body></html>",
  "<!DOCTYPE html><html><head><title>Error 404</title></head><body><h1>404 - Resource Not Found</h1><p>Please check the URL or contact the administrator.</p></body></html>",
  "<html><head><title>Not Found</title></head><body><center><h1>404</h1><p>Nothing to see here.</p></center></body></html>",
  "<!DOCTYPE html><html><head><meta charset='utf-8'><title>404</title></head><body><h1>File Not Found</h1></body></html>",
];

const FAKE_HEALTH_JSON = JSON.stringify({
  status: "ok",
  uptime: Math.floor(Date.now() / 1000) % 86400,
  version: "2.1.3",
  timestamp: Date.now(),
});

// ---------- Main Handler ----------
export default async function handler(req) {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = Date.now();
  let slotAcquired = false;
  const url = new URL(req.url);

  // ---- 1. Fake Health Check Endpoint ----
  if (url.pathname === FAKE_HEALTH_PATH) {
    const respHeaders = new Headers();
    respHeaders.set("content-type", "application/json; charset=utf-8");
    respHeaders.set("server", randomItem(SERVER_NAMES));
    if (Math.random() > 0.5) respHeaders.set("x-content-type-options", "nosniff");
    if (Math.random() > 0.7) respHeaders.set("x-frame-options", "DENY");
    return new Response(FAKE_HEALTH_JSON, { status: 200, headers: respHeaders });
  }

  // ---- 2. Validation (missing target domain) ----
  if (!TARGET_BASE) {
    const decoyHTML = randomItem(DECOY_404_TEMPLATES);
    return new Response(decoyHTML, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) },
    });
  }

  // ---- 3. Path Validation (relay only on designated path) ----
  if (!(url.pathname === RELAY_PATH || url.pathname.startsWith(`${RELAY_PATH}/`))) {
    const decoyHTML = randomItem(DECOY_404_TEMPLATES);
    return new Response(decoyHTML, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) },
    });
  }

  // ---- 4. Method Validation ----
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // ---- 5. Authentication (optional) ----
  if (RELAY_KEY) {
    const authToken = req.headers.get("x-relay-key") || "";
    if (authToken !== RELAY_KEY) {
      const decoyHTML = randomItem(DECOY_404_TEMPLATES);
      return new Response(decoyHTML, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "server": randomItem(SERVER_NAMES) },
      });
    }
  }

  // ---- 6. Concurrency Limit ----
  if (!tryAcquireSlot()) {
    return new Response("Service Unavailable", { status: 503, headers: { "retry-after": "1" } });
  }
  slotAcquired = true;

  try {
    // Build target URL
    const targetUrl = `${TARGET_BASE}${url.pathname}${url.search}`;

    // Filter and forward headers
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
      headers.set(
        "user-agent",
        randomItem([
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0",
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
        ])
      );
    }

    // Optional jitter (disabled by default)
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

    // Build response headers (randomized)
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
    if (Math.random() > 0.7) responseHeaders.set("x-xss-protection", "1; mode=block");
    if (Math.random() > 0.6) responseHeaders.set("permissions-policy", "geolocation=()");

    if (process.env.ENABLE_LOGGING !== "0") {
      console.log(
        `[relay] ${requestId} ${req.method} ${url.pathname} → ${upstream.status} (${Date.now() - startedAt}ms)`
      );
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (process.env.ENABLE_LOGGING !== "0") {
      console.error(`[relay] ${requestId} error: ${error.message}`);
    }
    if (error.name === "AbortError") {
      return new Response("Gateway Timeout", { status: 504 });
    }
    return new Response("Bad Gateway", { status: 502 });
  } finally {
    if (slotAcquired) releaseSlot();
  }
}

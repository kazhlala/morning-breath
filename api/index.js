export const config = {
  runtime: "edge",
};

// ---------- Environment Variables ----------
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const RELAY_PATH = process.env.RELAY_PATH || "/xhttp-relay";
const RELAY_KEY = (process.env.RELAY_KEY || "").trim();
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS) || 60000;
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT) || 12;

// ---------- Whitelist ----------
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

// ---------- Simple Helpers ----------
function shouldForwardHeader(name) {
  const lower = name.toLowerCase();
  const block = [
    "host", "connection", "keep-alive", "transfer-encoding",
    "x-vercel-ip", "x-vercel-id", "x-real-ip", "cf-connecting-ip"
  ];
  if (block.includes(lower)) return false;
  if (lower.startsWith("x-vercel-") || lower.startsWith("cf-")) return false;
  return true;
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let inFlight = 0;
const SERVER_NAMES = ["nginx", "Apache/2.4.41 (Ubuntu)", "LiteSpeed"];

// ---------- Main Handler ----------
export default async function handler(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 1. Root path (landing page) - plain text to avoid any HTML error
  if (pathname === "/") {
    return new Response("morning-breath OK", {
      status: 200,
      headers: { "content-type": "text/plain", "server": randomItem(SERVER_NAMES) }
    });
  }

  // 2. Fake Health Check
  if (pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json", "server": randomItem(SERVER_NAMES) }
    });
  }

  // 3. Validate target domain
  if (!TARGET_BASE) {
    return new Response("Not Found", { status: 404 });
  }

  // 4. Path validation
  if (pathname !== RELAY_PATH && !pathname.startsWith(RELAY_PATH + "/")) {
    return new Response("Not Found", { status: 404 });
  }

  // 5. Method
  if (!ALLOWED_METHODS.has(req.method)) {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 6. Auth (optional)
  if (RELAY_KEY) {
    const auth = req.headers.get("x-relay-key") || "";
    if (auth !== RELAY_KEY) {
      return new Response("Not Found", { status: 404 });
    }
  }

  // 7. Concurrency
  if (inFlight >= MAX_INFLIGHT) {
    return new Response("Service Unavailable", { status: 503, headers: { "retry-after": "1" } });
  }
  inFlight++;

  try {
    const targetUrl = TARGET_BASE + pathname + url.search;

    // Build headers
    const headers = new Headers();
    for (const [key, value] of req.headers) {
      if (shouldForwardHeader(key)) {
        headers.set(key, value);
      }
    }
    // Remove relay key from going upstream
    headers.delete("x-relay-key");

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: abortController.signal,
        body: req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined,
        duplex: "half"
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // Build response headers
    const responseHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
      const lower = k.toLowerCase();
      if (lower === "transfer-encoding" || lower === "connection") continue;
      if (lower.startsWith("x-vercel-") || lower.startsWith("cf-")) continue;
      if (lower === "server" || lower === "x-powered-by") continue;
      responseHeaders.set(k, v);
    }
    responseHeaders.set("server", randomItem(SERVER_NAMES));

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(err.name === "AbortError" ? "Gateway Timeout" : "Bad Gateway", {
      status: err.name === "AbortError" ? 504 : 502,
    });
  } finally {
    inFlight = Math.max(0, inFlight - 1);
  }
}

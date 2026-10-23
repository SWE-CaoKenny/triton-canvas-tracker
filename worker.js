// Triton Canvas Tracker on Cloudflare Workers.
// Same API as server.js (the Node server, still used for local dev): static files are
// served by Workers Assets from ./public, and this Worker handles only the /api routes,
// which fetch a Canvas feed / Canvas API / Class Planner page on the user's behalf.
// Nothing is stored or logged: feed URLs and tokens stay in the user's browser.

import planner from "./planner.js";
import "./extension/shared.js";        // homework keywords, matching, estimates
import "./extension/canvas-scan.js";   // Canvas module scanner (shared with the extension)
const { TTCanvasScan } = globalThis;

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;

// ---------- Feed URL validation (prevents using this Worker as an open proxy) ----------
// Workers can't fetch private/internal addresses, so unlike server.js there is no DNS/IP
// blocklist; literal-IP hosts, non-443 ports and odd paths are still rejected up front.

const FEED_PATH = /^\/feeds\/calendars\/[A-Za-z0-9_\-]+\.ics$/;
const IP_HOST = /^(\d+\.){3}\d+$|:/;

function validateFeedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password || (u.port && u.port !== "443")) return null;
  if (IP_HOST.test(u.hostname)) return null;
  if (!FEED_PATH.test(u.pathname)) return null;
  return u;
}

class HttpError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function readCapped(res, maxBytes) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { reader.cancel(); throw new Error("response too large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

// GET a URL that already passed `validate`. Redirects are followed only if the new
// location passes `validate` too.
async function fetchText(u, { validate, accept, maxBytes }, redirectsLeft = MAX_REDIRECTS) {
  const res = await fetch(u, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "triton-canvas-tracker", Accept: accept },
  });
  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    await res.body?.cancel();
    if (redirectsLeft <= 0) throw new Error("too many redirects");
    const next = validate(new URL(location, u).toString());
    if (!next) throw new Error("redirected to a disallowed URL");
    return fetchText(next, { validate, accept, maxBytes }, redirectsLeft - 1);
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw new HttpError(`upstream responded ${res.status}`, res.status);
  }
  return readCapped(res, maxBytes);
}

async function fetchFeed(u) {
  const body = await fetchText(u, { validate: validateFeedUrl, accept: "text/calendar", maxBytes: MAX_FEED_BYTES });
  if (!body.startsWith("BEGIN:VCALENDAR")) throw new Error("not a calendar feed");
  return body;
}

// ---------- Simple per-IP rate limit (per isolate, so best-effort) ----------

const WINDOW_MS = 5 * 60_000, MAX_PER_WINDOW = 30;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  if (hits.size > 5000) for (const [k, h] of hits) if (now - h.start > WINDOW_MS) hits.delete(k);
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
  return ++h.n > MAX_PER_WINDOW;
}

const clientIp = req => req.headers.get("cf-connecting-ip") || "unknown";

// ---------- HTTP ----------

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function send(status, body, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, { status, headers: { "Content-Type": type, ...SECURITY_HEADERS, ...extra } });
}

async function readJson(req, limit = 4096) {
  const text = await req.text();
  if (text.length > limit) throw new Error("body too large");
  return JSON.parse(text);
}

// The feed URL is sent in a POST body (not the query string) so it never lands in
// access logs.
async function handleFeed(req) {
  if (req.method !== "POST") return send(405, "Method not allowed");
  if (rateLimited(clientIp(req))) return send(429, "Too many requests. Try again in a few minutes.");
  let raw = "";
  try { raw = (await readJson(req)).url || ""; } catch { return send(400, "Bad request"); }
  const feed = validateFeedUrl(String(raw).trim());
  if (!feed) {
    return send(400, "That doesn't look like a Canvas calendar feed link. It should look like https://canvas.yourschool.edu/feeds/calendars/user_….ics");
  }
  try {
    const body = await fetchFeed(feed);
    return send(200, body, "text/calendar; charset=utf-8", { "Cache-Control": "no-store" });
  } catch (e) {
    console.warn(`feed fetch failed: ${e.message}`); // never log the feed URL itself
    const msg = [400, 401, 403, 404].includes(e.status)
      ? "Canvas didn't recognize that feed link. Copy it again from Canvas → Calendar → Calendar Feed."
      : "Couldn't load the feed from Canvas. Check the link and try again.";
    return send(502, msg);
  }
}

// ---------- Canvas module scan with a personal access token ----------
// The token is used only for this one request: never stored, cached or logged.

const CANVAS_HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CANVAS_TOKEN = /^[A-Za-z0-9~._-]{20,256}$/;
const SCAN_MAX_CALLS = 150;
const SCAN_TIMEOUT_MS = 50_000;

class TokenRejected extends Error {}

function canvasTokenFetcher(base, token) {
  let calls = 0;
  const origin = new URL(base).origin;
  return async function getJson(url) {
    let u;
    try { u = new URL(url, base); } catch { throw new Error("bad url"); }
    if (u.origin !== origin) throw new Error("off-host url");
    if (++calls > SCAN_MAX_CALLS) throw new Error("scan too large");
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "triton-canvas-tracker" },
    });
    if (res.status === 401) { await res.body?.cancel(); throw new TokenRejected("token rejected"); }
    if (res.status !== 200) { await res.body?.cancel(); throw new HttpError(`Canvas ${res.status}`, res.status); }
    const text = await readCapped(res, MAX_FEED_BYTES);
    const data = JSON.parse(text.replace(/^while\(1\);/, ""));
    const m = (res.headers.get("link") || "").match(/<([^>]+)>;\s*rel="next"/);
    let next = null;
    if (m) { try { const n = new URL(m[1]); if (n.origin === origin) next = n.href; } catch {} }
    return { data, next };
  };
}

async function handleCanvasScan(req) {
  if (req.method !== "POST") return send(405, "Method not allowed");
  if (rateLimited(clientIp(req))) return send(429, "Too many requests. Try again in a few minutes.");
  let body;
  try { body = await readJson(req, 8192); } catch { return send(400, "Bad request"); }
  const host = String(body.host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const token = String(body.token || "").trim();
  if (!CANVAS_HOST.test(host) || IP_HOST.test(host)) return send(400, "That isn't a valid Canvas address (for example canvas.ucsd.edu).");
  if (!CANVAS_TOKEN.test(token)) return send(400, "That doesn't look like a Canvas access token. Copy it again from Canvas → Account → Settings.");
  const base = `https://${host}`;
  try {
    const result = await Promise.race([
      TTCanvasScan.scan({ base, getJson: canvasTokenFetcher(base, token), isLoginError: e => e instanceof TokenRejected }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("scan timed out")), SCAN_TIMEOUT_MS)),
    ]);
    return send(200, JSON.stringify({ ...result, scannedAt: Date.now() }), "application/json", { "Cache-Control": "no-store" });
  } catch (e) {
    console.warn(`canvas scan failed: ${e instanceof TokenRejected ? "token rejected" : e.message}`);  // never log the token
    if (e instanceof TokenRejected) return send(401, "Canvas didn't accept that access token. It may have expired or been deleted; create a new one in Canvas → Account → Settings.");
    return send(502, "Couldn't scan Canvas right now. Try again in a minute.");
  }
}

// ---------- UCSD Class Planner schedules ----------

const SCHEDULE_CACHE_MS = 15 * 60_000;
const scheduleCache = new Map();  // schedule ref -> { at, data }; share links are public

async function handleSchedule(req) {
  if (req.method !== "POST") return send(405, "Method not allowed");
  if (rateLimited(clientIp(req))) return send(429, "Too many requests. Try again in a few minutes.");
  let raw = "";
  try { raw = (await readJson(req)).url || ""; } catch { return send(400, "Bad request"); }
  const u = planner.validatePlannerUrl(String(raw).trim());
  if (!u) {
    return send(400, "That doesn't look like a Class Planner share link. It should look like https://classplanner.apps.ucsd.edu/view/CS2…");
  }
  const key = u.pathname;
  const hit = scheduleCache.get(key);
  if (hit && Date.now() - hit.at < SCHEDULE_CACHE_MS) {
    return send(200, JSON.stringify(hit.data), "application/json", { "Cache-Control": "no-store" });
  }
  try {
    const html = await fetchText(u, { validate: planner.validatePlannerUrl, accept: "text/html", maxBytes: 4 * 1024 * 1024 });
    const data = planner.parseSchedulePage(html);
    if (scheduleCache.size > 300) scheduleCache.delete(scheduleCache.keys().next().value);
    scheduleCache.set(key, { at: Date.now(), data });
    return send(200, JSON.stringify(data), "application/json", { "Cache-Control": "no-store" });
  } catch (e) {
    console.warn(`schedule fetch failed: ${e.message}`);
    const msg = e.status === 404
      ? "Class Planner couldn't find that schedule. Copy the link again from Class Planner → Save & share."
      : e.code === "PARSE"
        ? "Couldn't find a schedule at that link. Copy it again from Class Planner → Save & share. (If the link opens fine in Class Planner, please report this on GitHub.)"
        : "Couldn't reach Class Planner. Try again in a moment.";
    return send(502, msg);
  }
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (pathname === "/api/feed") return handleFeed(req);
    if (pathname === "/api/schedule") return handleSchedule(req);
    if (pathname === "/api/canvas-scan") return handleCanvasScan(req);
    if (pathname === "/healthz") return send(200, "ok");
    // Everything else is a static file (Workers Assets serves matches before this runs;
    // reaching here means no file matched).
    return env.ASSETS.fetch(req);
  },
};

// Triton Canvas Tracker server.
// Serves the static app and a narrow proxy that fetches a Canvas calendar feed (.ics)
// on the user's behalf, since browsers can't read Canvas feeds directly (CORS).
// Nothing is stored or logged: feed URLs stay in the user's browser.

const http = require("node:http");
const https = require("node:https");
const dns = require("node:dns");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const planner = require("./planner");
require("./extension/shared.js");        // homework keywords, matching, estimates
require("./extension/canvas-scan.js");   // Canvas module scanner (shared with the extension)
const { TTCanvasScan } = globalThis;

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 2;

// ---------- Feed URL validation (prevents using this server as an open proxy) ----------

const FEED_PATH = /^\/feeds\/calendars\/[A-Za-z0-9_\-]+\.ics$/;

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(addr, prefix, "ipv4");
// Note: don't add ::ffff:0:0/96 here. Node's BlockList matches IPv4 addresses against
// IPv4-mapped IPv6 rules, so that rule would block every IPv4 address.
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(addr, prefix, "ipv6");

function isBlockedIp(ip, family) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  return blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
}

function validateFeedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:") return null;
  if (u.username || u.password || (u.port && u.port !== "443")) return null;
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) return null;
  if (!FEED_PATH.test(u.pathname)) return null;
  return u;
}

// Resolve DNS ourselves and refuse private/internal addresses. Doing this inside the
// socket's lookup (rather than beforehand) means the checked IP is the one connected to.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some(a => isBlockedIp(a.address, a.family))) {
      return cb(new Error("blocked address"));
    }
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

// GET a URL that already passed `validate`. Redirects are followed only if the new
// location passes `validate` too.
function fetchText(u, { validate, accept, maxBytes }, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, {
      lookup: safeLookup,
      timeout: FETCH_TIMEOUT_MS,
      headers: { "User-Agent": "triton-canvas-tracker", Accept: accept },
    }, res => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error("too many redirects"));
        const next = validate(new URL(headers.location, u).toString());
        if (!next) return reject(new Error("redirected to a disallowed URL"));
        return resolve(fetchText(next, { validate, accept, maxBytes }, redirectsLeft - 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(Object.assign(new Error(`upstream responded ${statusCode}`), { status: statusCode }));
      }
      const chunks = [];
      let size = 0;
      res.on("data", c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); reject(new Error("response too large")); }
        else chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
  });
}

async function fetchFeed(u) {
  const body = await fetchText(u, { validate: validateFeedUrl, accept: "text/calendar", maxBytes: MAX_FEED_BYTES });
  if (!body.startsWith("BEGIN:VCALENDAR")) throw new Error("not a calendar feed");
  return body;
}

// ---------- Simple per-IP rate limit ----------

const WINDOW_MS = 5 * 60_000, MAX_PER_WINDOW = 30;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.start > WINDOW_MS) { hits.set(ip, { start: now, n: 1 }); return false; }
  return ++h.n > MAX_PER_WINDOW;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now - h.start > WINDOW_MS) hits.delete(ip);
}, WINDOW_MS).unref();

const clientIp = req =>
  (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;

// ---------- HTTP ----------

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".json": "application/json", ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

function send(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => {
      data += c;
      if (data.length > limit) { req.destroy(); reject(new Error("body too large")); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// The feed URL is sent in a POST body (not the query string) so it never lands in
// access logs of Railway or any proxy in between.
async function handleFeed(req, res) {
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (rateLimited(clientIp(req))) return send(res, 429, "Too many requests. Try again in a few minutes.");
  let raw = "";
  try { raw = JSON.parse(await readBody(req)).url || ""; } catch { return send(res, 400, "Bad request"); }
  const feed = validateFeedUrl(String(raw).trim());
  if (!feed) {
    return send(res, 400, "That doesn't look like a Canvas calendar feed link. It should look like https://canvas.yourschool.edu/feeds/calendars/user_….ics");
  }
  try {
    const body = await fetchFeed(feed);
    send(res, 200, body, "text/calendar; charset=utf-8", { "Cache-Control": "no-store" });
  } catch (e) {
    console.warn(`feed fetch failed: ${e.message}`); // never log the feed URL itself
    const msg = [400, 401, 403, 404].includes(e.status)
      ? "Canvas didn't recognize that feed link. Copy it again from Canvas → Calendar → Calendar Feed."
      : "Couldn't load the feed from Canvas. Check the link and try again.";
    send(res, 502, msg);
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
  return function getJson(url) {
    return new Promise((resolve, reject) => {
      let u;
      try { u = new URL(url, base); } catch { return reject(new Error("bad url")); }
      if (u.origin !== origin) return reject(new Error("off-host url"));
      if (++calls > SCAN_MAX_CALLS) return reject(new Error("scan too large"));
      const req = https.get(u, {
        lookup: safeLookup, timeout: FETCH_TIMEOUT_MS,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "triton-canvas-tracker" },
      }, res => {
        if (res.statusCode === 401) { res.resume(); return reject(new TokenRejected("token rejected")); }
        if (res.statusCode !== 200) { res.resume(); return reject(Object.assign(new Error(`Canvas ${res.statusCode}`), { status: res.statusCode })); }
        const chunks = []; let size = 0;
        res.on("data", c => { size += c.length; if (size > MAX_FEED_BYTES) req.destroy(new Error("too large")); else chunks.push(c); });
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/^while\(1\);/, ""));
            const m = (res.headers.link || "").match(/<([^>]+)>;\s*rel="next"/);
            let next = null;
            if (m) { try { const n = new URL(m[1]); if (n.origin === origin) next = n.href; } catch {} }
            resolve({ data, next });
          } catch (e) { reject(e); }
        });
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
    });
  };
}

async function handleCanvasScan(req, res) {
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (rateLimited(clientIp(req))) return send(res, 429, "Too many requests. Try again in a few minutes.");
  let body;
  try { body = JSON.parse(await readBody(req, 8192)); } catch { return send(res, 400, "Bad request"); }
  const host = String(body.host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const token = String(body.token || "").trim();
  if (!CANVAS_HOST.test(host) || net.isIP(host)) return send(res, 400, "That isn't a valid Canvas address (for example canvas.ucsd.edu).");
  if (!CANVAS_TOKEN.test(token)) return send(res, 400, "That doesn't look like a Canvas access token. Copy it again from Canvas → Account → Settings.");
  const base = `https://${host}`;
  try {
    const result = await Promise.race([
      TTCanvasScan.scan({ base, getJson: canvasTokenFetcher(base, token), isLoginError: e => e instanceof TokenRejected }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("scan timed out")), SCAN_TIMEOUT_MS)),
    ]);
    send(res, 200, JSON.stringify({ ...result, scannedAt: Date.now() }), "application/json", { "Cache-Control": "no-store" });
  } catch (e) {
    console.warn(`canvas scan failed: ${e instanceof TokenRejected ? "token rejected" : e.message}`);  // never log the token
    if (e instanceof TokenRejected) return send(res, 401, "Canvas didn't accept that access token. It may have expired or been deleted; create a new one in Canvas → Account → Settings.");
    send(res, 502, "Couldn't scan Canvas right now. Try again in a minute.");
  }
}

// ---------- UCSD Class Planner schedules ----------

const SCHEDULE_CACHE_MS = 15 * 60_000;
const scheduleCache = new Map();  // schedule ref -> { at, data }; share links are public

async function handleSchedule(req, res) {
  if (req.method !== "POST") return send(res, 405, "Method not allowed");
  if (rateLimited(clientIp(req))) return send(res, 429, "Too many requests. Try again in a few minutes.");
  let raw = "";
  try { raw = JSON.parse(await readBody(req)).url || ""; } catch { return send(res, 400, "Bad request"); }
  const u = planner.validatePlannerUrl(String(raw).trim());
  if (!u) {
    return send(res, 400, "That doesn't look like a Class Planner share link. It should look like https://classplanner.apps.ucsd.edu/view/CS2…");
  }
  const key = u.pathname;
  const hit = scheduleCache.get(key);
  if (hit && Date.now() - hit.at < SCHEDULE_CACHE_MS) {
    return send(res, 200, JSON.stringify(hit.data), "application/json", { "Cache-Control": "no-store" });
  }
  try {
    const html = await fetchText(u, { validate: planner.validatePlannerUrl, accept: "text/html", maxBytes: 4 * 1024 * 1024 });
    const data = planner.parseSchedulePage(html);
    if (scheduleCache.size > 300) scheduleCache.delete(scheduleCache.keys().next().value);
    scheduleCache.set(key, { at: Date.now(), data });
    send(res, 200, JSON.stringify(data), "application/json", { "Cache-Control": "no-store" });
  } catch (e) {
    console.warn(`schedule fetch failed: ${e.message}`);
    const msg = e.status === 404
      ? "Class Planner couldn't find that schedule. Copy the link again from Class Planner → Save & share."
      : e.code === "PARSE"
        ? "Couldn't find a schedule at that link. Copy it again from Class Planner → Save & share. (If the link opens fine in Class Planner, please report this on GitHub.)"
        : "Couldn't reach Class Planner. Try again in a moment.";
    send(res, 502, msg);
  }
}

function serveStatic(res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, "Not found");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    send(res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return send(res, 400, "Bad request"); }
  if (url.pathname === "/api/feed") return handleFeed(req, res);
  if (url.pathname === "/api/schedule") return handleSchedule(req, res);
  if (url.pathname === "/api/canvas-scan") return handleCanvasScan(req, res);
  if (url.pathname === "/lib/shared.js") return fs.readFile(path.join(__dirname, "extension", "shared.js"), (err, data) =>
    err ? send(res, 404, "Not found") : send(res, 200, data, "text/javascript; charset=utf-8"));
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  if (url.pathname === "/healthz") return send(res, 200, "ok");
  serveStatic(res, url.pathname);
});

server.listen(PORT, () => console.log(`Triton Canvas Tracker running on http://localhost:${PORT}`));

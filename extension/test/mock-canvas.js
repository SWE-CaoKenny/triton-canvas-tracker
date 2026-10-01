// Fake Canvas for testing the Triton Sync bookmarklet end to end.
// Run: PORT=8092 TRACKER=http://localhost:3000 node extension/test/mock-canvas.js
// Then open http://localhost:8092/ and click "Run Triton Sync" (it runs the real bookmarklet).
const http = require("node:http");
const PORT = +process.env.PORT || 8092;
const TRACKER = process.env.TRACKER || "http://localhost:3000";
const B = `http://localhost:${PORT}`;
const D = 864e5, now = Date.now();
const iso = ms => new Date(ms).toISOString();

const routes = {
  "/api/v1/users/self/courses": [
    { id: 1, name: "MATH020C_FA26_002", course_code: "MATH 20C", term: { end_at: iso(now + 70 * D) } },
    { id: 2, name: "PHIL027_FA26_001", course_code: "PHIL 27", term: { end_at: iso(now + 70 * D) } },
  ],
  "/api/v1/courses/1/assignments": [
    { name: "Homework 1", due_at: iso(now - 6 * D), unlock_at: iso(now - 13 * D) },
    { name: "Homework 2", due_at: iso(now + 1 * D), created_at: iso(now - 6 * D) },
  ],
  "/api/v1/courses/2/assignments": [],
  "/api/v1/courses/1/modules": [
    { name: "Week 1", items: [
      { id: 11, type: "File", title: "HW1.pdf", url: `${B}/api/v1/courses/1/files/101`, html_url: `${B}/courses/1/modules/items/11` },
      { id: 12, type: "File", title: "Lecture 1 slides.pdf", url: `${B}/api/v1/courses/1/files/102` },
    ] },
    { name: "Week 3", items: [
      { id: 31, type: "File", title: "HW3.pdf", url: `${B}/api/v1/courses/1/files/301`, html_url: `${B}/courses/1/modules/items/31` },
      { id: 32, type: "File", title: "HW3_solutions.pdf", url: `${B}/api/v1/courses/1/files/302` },
    ] },
  ],
  "/api/v1/courses/2/modules": [
    { name: "Week 2", items: [
      { id: 41, type: "File", title: "Worksheet 2.pdf", url: `${B}/api/v1/courses/2/files/401`, html_url: `${B}/courses/2/modules/items/41` },
      { id: 42, type: "Page", title: "Reading Response 1 <script>alert(1)</script>", url: `${B}/api/v1/courses/2/pages/rr1`, html_url: `${B}/courses/2/pages/rr1` },
    ] },
  ],
  "/api/v1/courses/1/files/101": { created_at: iso(now - 13 * D) },
  "/api/v1/courses/1/files/301": { created_at: iso(now - 1 * D) },
  "/api/v1/courses/2/files/401": { created_at: iso(now - 2 * D) },
  "/api/v1/courses/2/pages/rr1": { created_at: iso(now - 3 * D) },
};

http.createServer(async (req, res) => {
  const u = new URL(req.url, B);
  if (u.pathname.startsWith("/api/")) {
    const data = routes[u.pathname];
    if (!data) { res.writeHead(404); return res.end("{}"); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end("while(1);" + JSON.stringify(data));     // like real Canvas with cookie auth
  }
  let code = "";
  try { code = (await (await fetch(`${TRACKER}/bookmarklet.js`)).text()).replace("__TT_ORIGIN__", TRACKER); } catch {}
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Fake Canvas</title><script>window.ENV = { current_user_id: "1" };</script>
<h1>Fake Canvas dashboard</h1><a id="bm" href="javascript:${encodeURIComponent(code)}">Run Triton Sync</a>`);
}).listen(PORT, () => console.log(`fake Canvas on ${B}`));

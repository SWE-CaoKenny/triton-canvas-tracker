// Run: node extension/test/canvas-scan.test.js — scanner against a fake Canvas API.
require("../shared.js"); require("../canvas-scan.js");
const { TTCanvasScan, TTShared } = globalThis;
const assert = require("node:assert/strict");
const B = "https://canvas.example.edu";
const iso = (m, d, h = 9) => new Date(2026, m - 1, d, h, 0).toISOString();
const routes = {
  "/api/v1/users/self/courses": [
    { id: 1, name: "MATH020C_FA26", course_code: "MATH 20C", term: { end_at: iso(12, 15) } },
    { id: 2, name: "OLD101_SP26", course_code: "OLD 101", term: { end_at: iso(6, 10) } },
  ],
  "/api/v1/courses/1/assignments": [
    { name: "Homework 1", due_at: iso(10, 7, 23), unlock_at: iso(9, 30) },
    { name: "Homework 2", due_at: iso(10, 14, 23), created_at: iso(10, 7) },
    { name: "Midterm 1", due_at: iso(10, 21, 20), created_at: iso(9, 20) },
  ],
  "/api/v1/courses/1/modules": [
    { name: "Week 1", items: [
      { id: 11, type: "File", title: "HW1.pdf", url: `${B}/api/v1/courses/1/files/101`, html_url: `${B}/courses/1/modules/items/11` },
      { id: 12, type: "File", title: "Lecture 1 slides.pdf", url: `${B}/api/v1/courses/1/files/102` },
      { id: 13, type: "File", title: "HW1 solutions.pdf", url: `${B}/api/v1/courses/1/files/103` },
    ] },
    { name: "Week 3", items: [
      { id: 31, type: "File", title: "HW3.pdf", url: `${B}/api/v1/courses/1/files/301`, html_url: `${B}/courses/1/modules/items/31` },
      { id: 32, type: "Page", title: "Worksheet 3", url: `${B}/api/v1/courses/1/pages/worksheet-3`, html_url: `${B}/courses/1/pages/worksheet-3` },
      { id: 33, type: "Quiz", title: "Quiz 3" },
      { id: 34, type: "ExternalUrl", title: "HW 4 (due 10/30)", external_url: "https://example.com", html_url: `${B}/courses/1/modules/items/34` },
    ] },
  ],
  "/api/v1/courses/1/files/101": { created_at: iso(9, 30) },
  "/api/v1/courses/1/files/301": { created_at: iso(10, 14) },
  "/api/v1/courses/1/pages/worksheet-3": { created_at: iso(10, 14, 12) },
};
let calls = 0;
const getJson = async url => {
  calls++;
  const u = new URL(url);
  assert.equal(u.origin, B, "scanner must stay on the Canvas host");
  if (u.pathname.startsWith("/api/v1/courses/2/")) throw Object.assign(new Error("Canvas 403"), { status: 403 });
  const data = routes[u.pathname];
  if (!data) throw new Error("404 " + u.pathname);
  return { data, next: null };
};
(async () => {
  const r = await TTCanvasScan.scan({ base: B, getJson, now: new Date(2026, 9, 15).getTime() });
  assert.equal(r.courseCount, 1, "old term filtered out");
  assert.deepEqual(r.hw.map(h => h.title), ["HW1", "HW3", "Worksheet 3", "HW 4 (due 10/30)"]);
  assert.equal(r.hw.find(h => h.title === "HW3").postedFrom, "upload date");
  assert.equal(new Date(r.hw.find(h => h.title.startsWith("HW 4")).due).getDate(), 30);
  const { items, undated } = TTShared.mergeHomework(r.hw, [], r.known);
  const t = Object.fromEntries(items.map(i => [i.title, i]));
  assert.ok(!t.HW1, "HW1.pdf is already the dated Canvas assignment 'Homework 1'");
  assert.equal(t.HW3.estimated, true);
  assert.equal(new Date(t.HW3.due).toDateString(), new Date(2026, 9, 21).toDateString());   // posted 10/14 + 7
  assert.equal(new Date(t.HW3.due).getHours(), 23);                                          // course's usual time
  assert.ok(t["Worksheet 3"].estimated);
  assert.equal(t["HW 4 (due 10/30)"].estimated, undefined, "date from the title is real, not estimated");
  assert.equal(undated.length, 0);
  console.log(`canvas-scan: passed (${calls} API calls)`);
})().catch(e => { console.error(e); process.exit(1); });

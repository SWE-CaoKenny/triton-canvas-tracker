// Triton Tracker Sync: background service worker.
// Uses your existing Canvas and Gradescope logins (cookies) to find homework the Canvas
// calendar misses. Never sees or stores passwords; never clicks or submits anything.
importScripts("shared.js");
const S = self.TTShared;

const CANVAS = "https://canvas.ucsd.edu";
const GS = "https://www.gradescope.com";
const SYNC_EVERY_MIN = 180;
const MIN_GAP_MS = 10 * 60_000;       // don't re-sync more often than this unless asked

const get = keys => chrome.storage.local.get(keys);
const set = obj => chrome.storage.local.set(obj);

// ---------- Canvas (documented REST API, authenticated by your session cookie) ----------

class LoginNeeded extends Error {}

async function canvasJson(url) {
  const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
  if (res.status === 401 || res.status === 403 || /\/login/.test(res.url)) throw new LoginNeeded("canvas");
  if (!res.ok) throw new Error(`Canvas ${res.status}`);
  const body = (await res.text()).replace(/^while\(1\);/, "");   // Canvas's JSON-hijacking guard
  const next = (res.headers.get("Link") || "").match(/<([^>]+)>;\s*rel="next"/);
  return { data: JSON.parse(body), next: next ? next[1] : null };
}

async function canvasAll(url, maxPages = 10) {
  const out = [];
  for (let i = 0; url && i < maxPages; i++) {
    const { data, next } = await canvasJson(url);
    out.push(...data);
    url = next;
  }
  return out;
}

const SKIP_TYPES = new Set(["Discussion", "Quiz"]);   // already in the calendar feed

async function syncCanvas() {
  const now = Date.now();
  const courses = (await canvasAll(`${CANVAS}/api/v1/users/self/courses?enrollment_state=active&include[]=term&per_page=100`))
    .filter(c => c && !c.access_restricted_by_date && c.name)
    .filter(c => !c.term || !c.term.end_at || Date.parse(c.term.end_at) > now - 14 * 864e5);

  const found = [];
  for (const c of courses) {
    const course = S.shortCourse(c.course_code || c.name);
    let modules;
    try {
      modules = await canvasAll(`${CANVAS}/api/v1/courses/${c.id}/modules?include[]=items&include[]=content_details&per_page=50`, 5);
    } catch (e) {
      if (e instanceof LoginNeeded) throw e;
      continue;                      // modules tab hidden in this course
    }
    const seenKeys = new Set();
    for (const mod of modules) {
      let items = mod.items;
      if (!items && mod.items_url) {
        try { items = await canvasAll(`${mod.items_url}${mod.items_url.includes("?") ? "&" : "?"}include[]=content_details&per_page=100`, 3); }
        catch { items = []; }
      }
      for (const it of items || []) {
        if (SKIP_TYPES.has(it.type)) continue;
        if (it.type === "Assignment" && it.content_details && it.content_details.due_at) continue; // in feed
        const title = S.cleanTitle(it.title);
        if (!S.isHomeworkTitle(title)) continue;
        const k = S.homeworkKey(title);
        if (k) { if (seenKeys.has(k.key)) continue; seenKeys.add(k.key); }
        found.push({
          uid: `cm-${c.id}-${it.id}`,
          title, course,
          due: S.dateFromText(`${it.title} ${mod.name}`) || null,
          link: it.html_url || `${CANVAS}/courses/${c.id}/modules`,
          module: mod.name,
        });
      }
    }
  }
  return { hw: found, courseCount: courses.length };
}

// ---------- Gradescope (HTML pages, parsed in an offscreen document) ----------

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Read Gradescope assignment pages",
  });
}

async function parseHtml(kind, html, extra = {}) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", kind, html, ...extra });
}

async function gsHtml(path) {
  const res = await fetch(GS + path, { credentials: "include" });
  if (/\/login/.test(res.url)) throw new LoginNeeded("gradescope");
  if (!res.ok) throw new Error(`Gradescope ${res.status}`);
  return res.text();
}

async function syncGradescope() {
  const dash = await parseHtml("dashboard", await gsHtml("/"));
  if (!dash.loggedIn) throw new LoginNeeded("gradescope");
  const { gsCourses = {} } = await get("gsCourses");
  const fresh = {};
  for (const c of dash.courses) {
    try {
      const r = await parseHtml("course", await gsHtml(`/courses/${c.id}`), { courseId: c.id, short: c.short });
      if (!r.loggedIn) throw new LoginNeeded("gradescope");
      fresh[c.id] = { course: r.course, assignments: r.assignments, foundTable: r.foundTable, at: Date.now() };
    } catch (e) {
      if (e instanceof LoginNeeded) throw e;
      if (gsCourses[c.id]) fresh[c.id] = gsCourses[c.id];   // keep last good copy
    }
  }
  await set({ gsCourses: fresh });
  return { courseCount: dash.courses.length, allCount: dash.allCount };
}

// ---------- Sync + publish ----------

async function publish() {
  const { canvasHw = [], gsCourses = {}, status = {} } = await get(["canvasHw", "gsCourses", "status"]);
  const gsAll = Object.values(gsCourses).flatMap(c => c.assignments || []);
  const { items, undated } = S.mergeHomework(canvasHw, gsAll);
  await set({ syncData: { items, undated, status, at: Date.now(), version: chrome.runtime.getManifest().version } });
}

let running = null;
async function syncAll({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const { status: prev = {} } = await get("status");
    if (!force && prev.lastSync && Date.now() - prev.lastSync < MIN_GAP_MS) return prev;
    const status = { lastSync: Date.now() };
    try {
      const r = await syncCanvas();
      await set({ canvasHw: r.hw });
      Object.assign(status, { canvas: "ok", canvasCourses: r.courseCount, canvasFound: r.hw.length });
    } catch (e) {
      status.canvas = e instanceof LoginNeeded ? "login" : "error";
      status.canvasError = String(e.message || e);
    }
    try {
      const r = await syncGradescope();
      Object.assign(status, { gradescope: "ok", gsCourses: r.courseCount });
    } catch (e) {
      status.gradescope = e instanceof LoginNeeded ? "login" : "error";
      status.gsError = String(e.message || e);
    }
    await set({ status });
    await publish();
    await updateBadge(status);
    return status;
  })();
  try { return await running; } finally { running = null; }
}

async function updateBadge(status) {
  const needsLogin = status.canvas === "login" || status.gradescope === "login";
  await chrome.action.setBadgeText({ text: needsLogin ? "!" : "" });
  if (needsLogin) await chrome.action.setBadgeBackgroundColor({ color: "#b3261e" });
}

async function scheduleAlarm() {
  const { settings = { background: true } } = await get("settings");
  await chrome.alarms.clear("sync");
  if (settings.background) chrome.alarms.create("sync", { periodInMinutes: SYNC_EVERY_MIN, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { scheduleAlarm(); syncAll({ force: true }); });
chrome.runtime.onStartup.addListener(() => { scheduleAlarm(); syncAll(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === "sync") syncAll(); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === "offscreen") return false;
  (async () => {
    if (msg.type === "syncNow") return syncAll({ force: !!msg.force });
    if (msg.type === "getState") return get(["syncData", "status", "settings", "gsCourses", "canvasHw"]);
    if (msg.type === "setBackground") {
      await set({ settings: { background: !!msg.value } });
      await scheduleAlarm();
      return { ok: true };
    }
    if (msg.type === "gsCourseCaptured") {
      // You opened a Gradescope course page; use what's on screen (no extra requests).
      const { gsCourses = {} } = await get("gsCourses");
      const prev = gsCourses[msg.courseId];
      gsCourses[msg.courseId] = {
        course: (prev && prev.course) || msg.result.course,
        assignments: msg.result.assignments.map(a => ({ ...a, course: (prev && prev.course) || a.course })),
        foundTable: true, at: Date.now(), passive: true,
      };
      await set({ gsCourses });
      await publish();
      return { ok: true };
    }
    return null;
  })().then(reply, err => reply({ error: String(err) }));
  return true;
});

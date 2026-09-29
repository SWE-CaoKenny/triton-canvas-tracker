(() => {
"use strict";

const CFG = window.TRACKER_CONFIG;
const H = 3600e3, D = 24 * H;
const PALETTE = ["#00629B", "#6E963B", "#C4457B", "#E07B00", "#7B4FA0", "#008C95", "#B03A2E", "#3F7FBF", "#9A7B00", "#5B6770"];

// ---------- Storage (browser-only; wrapped because storage can be unavailable) ----------

const store = {
  get(k, d) { try { const v = localStorage.getItem("tt:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("tt:" + k, JSON.stringify(v)); } catch {} },
  clear() { try { Object.keys(localStorage).filter(k => k.startsWith("tt:")).forEach(k => localStorage.removeItem(k)); } catch {} },
};

const state = {
  items: [],
  done: new Set(store.get("done", [])),
  hidden: new Set(store.get("hidden", [])),
  weights: store.get("weights", {}),
  sort: store.get("sort", "due"),
  tab: store.get("tab", "list"),
  weekOffset: 0,
  host: store.get("host", CFG.canvasHost),
  showEvents: store.get("showEvents", false),
  feedItems: [],
  custom: store.get("custom", []),  // items the user added by hand
  schedule: store.get("schedule", null),  // parsed UCSD Class Planner schedule
  scheduleError: null,
};

// ---------- DOM helpers ----------

const $ = s => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}
const svg = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };

// ---------- ICS parsing ----------

function unescapeIcs(s) {
  return s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseIcsDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (!hh || /VALUE=DATE(?!-)/.test(params)) return new Date(+y, mo - 1, +d, 23, 59).getTime();
  if (z) return Date.UTC(+y, mo - 1, +d, +hh, +mm, +ss);
  return new Date(+y, mo - 1, +d, +hh, +mm, +ss).getTime();
}

const EXAM_RE = /\b(midterm|mid-term|final exam|final|exam|test)s?\b/i;
const QUIZ_RE = /\bquiz(zes)?\b/i;

function kindOf(title, uid) {
  if (/\bpractice\b/i.test(title)) return /assignment/.test(uid) ? "assignment" : "event-lite";
  if (EXAM_RE.test(title) && !/\b(final (project|paper|essay|report|draft))\b/i.test(title)) return "exam";
  if (QUIZ_RE.test(title)) return "quiz";
  if (/assignment/.test(uid)) return "assignment";
  return "event";
}

function shortCourse(full) {
  // "MATH 20A - Calculus", "CSE020_FA26_001", "PSYC 3" -> "MATH 20A", "CSE 20", "PSYC 3"
  const m = full.match(/(?:^|[^A-Za-z])([A-Z]{2,5})[\s_-]*0*(\d{1,3}[A-Z]{0,3})(?![A-Za-z0-9])/);
  if (m) return `${m[1]} ${m[2]}`;
  return full.length > 22 ? full.slice(0, 20).trim() + "…" : full;
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") {
      if (cur && cur.SUMMARY && cur.DTSTART) {
        let title = unescapeIcs(cur.SUMMARY.value);
        let course = "Other";
        const bm = title.match(/^(.*)\s\[([^\]]+)\]\s*$/);
        if (bm) { title = bm[1].trim(); course = bm[2].trim(); }
        const due = parseIcsDate(cur.DTSTART.value, cur.DTSTART.params);
        const uid = cur.UID ? cur.UID.value : `${course}|${title}|${due}`;
        let link = cur.URL ? unescapeIcs(cur.URL.value) : null;
        try { if (link && new URL(link).protocol !== "https:") link = null; } catch { link = null; }
        if (due) items.push({ uid, title, course, due, link, kind: kindOf(title, uid) });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(";");
    cur[name.toUpperCase()] = { value: line.slice(i + 1), params: params.join(";") };
  }
  // De-dupe (Canvas sometimes lists overrides twice)
  const seen = new Map();
  for (const it of items) seen.set(it.uid, it);
  return mergeWindows([...seen.values()]);
}

// Some courses post a testing window as one calendar event per day ("Test 2 - Testing
// window" x 7). Collapse runs of the same event on consecutive days into one item with a
// start and end. Weekly repeats (e.g. "Review quiz due") stay separate.
function mergeWindows(items) {
  const groups = new Map(), out = [];
  for (const it of items) {
    if (it.uid.includes("assignment")) { out.push(it); continue; }
    const k = it.course + "\u0000" + it.title.toLowerCase();
    (groups.get(k) || groups.set(k, []).get(k)).push(it);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => a.due - b.due);
    let run = [list[0]];
    const flush = () => {
      if (run.length === 1) out.push(run[0]);
      else {
        const first = run[0], last = run[run.length - 1];
        const start = new Date(first.due); start.setHours(0, 0, 0, 0);
        out.push({ ...last, uid: first.uid + "~window", start: start.getTime(), days: run.length });
      }
    };
    for (const it of list.slice(1)) {
      if (it.due - run[run.length - 1].due <= 1.5 * D) run.push(it);
      else { flush(); run = [it]; }
    }
    flush();
  }
  return out;
}

// ---------- Grade weights ----------

const splitKw = s => s.split(",").map(k => k.trim().toLowerCase()).filter(Boolean);

function categoryFor(item) {
  const cats = state.weights[item.course] || [];
  const t = item.title.toLowerCase();
  return cats.find(c => splitKw(c.kw || "").some(k => t.includes(k))) || null;
}

// Share of the final grade for an item: category weight split evenly across its items.
function gradeShare(item) {
  const cat = categoryFor(item);
  if (!cat || !(+cat.weight > 0)) return null;
  const n = +cat.count > 0 ? +cat.count
    : state.items.filter(i => i.course === item.course && categoryFor(i) === cat).length;
  return n ? +cat.weight / n : null;
}

const fmtPct = p => (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)).replace(/\.0+$/, "") + "%";

// ---------- Colors ----------

function courseColors() {
  const courses = [...new Set(state.items.map(i => i.course))].sort();
  const saved = store.get("colors-light", {});
  const used = new Set(Object.values(saved));
  let next = 0;
  for (const c of courses) {
    if (saved[c]) continue;
    while (used.has(PALETTE[next % PALETTE.length]) && next < PALETTE.length) next++;
    saved[c] = PALETTE[next % PALETTE.length];
    used.add(saved[c]); next++;
  }
  store.set("colors-light", saved);
  return saved;
}

// ---------- Rendering ----------

const isExam = it => it.kind === "exam" || it.kind === "quiz";
const TYPE_LABEL = { exam: "Exam", quiz: "Quiz", assignment: "Assignment", "event-lite": "Practice", event: "Event" };
const CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';
const fmtDue = t => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtDay = t => new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const fmtTime = t => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const isAllDay = t => { const d = new Date(t); return d.getHours() === 23 && d.getMinutes() === 59; };

function fmtSpan(ms) {
  const d = Math.floor(ms / D), hr = Math.floor(ms % D / H), m = Math.floor(ms % H / 60e3);
  if (d >= 1) return `${d}d ${hr}h`;
  if (hr >= 1) return `${hr}h ${m}m`;
  return `${m}m`;
}

function timeLeft(it, now) {
  const ms = it.due - now;
  if (ms < 0) return { text: `${fmtSpan(-ms)} late`, cls: "u-late" };
  const cls = ms < D ? "u-red" : ms < 3 * D ? "u-orange" : ms < 7 * D ? "u-blue" : "u-green";
  if (it.start && it.start > now) return { text: `opens in ${fmtSpan(it.start - now)}`, cls };
  if (it.start) return { text: `${fmtSpan(ms)} left`, cls };
  return { text: fmtSpan(ms), cls };
}

function toggleDone(it) {
  state.done.has(it.uid) ? state.done.delete(it.uid) : state.done.add(it.uid);
  store.set("done", [...state.done]);
  render();
}

function checkBtn(it) {
  const done = state.done.has(it.uid);
  return h("button", {
    class: "check", title: done ? "Mark not done" : "Mark done", "aria-label": done ? "Mark not done" : "Mark done",
    onclick: () => toggleDone(it),
  }, svg(CHECK_SVG));
}

function titleEl(it) {
  if (it.custom) return h("button", { type: "button", class: "link-btn", title: "Edit this item", onclick: () => openItem(it.uid) }, it.title);
  return it.link ? h("a", { href: it.link, target: "_blank", rel: "noopener" }, it.title) : it.title;
}

function row(it, colors, now, alt) {
  const share = gradeShare(it);
  const left = timeLeft(it, now);
  return h("tr", { class: "row" + (alt ? " alt" : "") + (isExam(it) ? " exam" : "") + (state.done.has(it.uid) ? " done" : "") },
    h("td", { class: "c-check" }, checkBtn(it)),
    h("td", { class: "c-title" },
      h("span", { class: "t-title" }, titleEl(it)),
      isExam(it) && h("span", { class: "badge" }, it.kind === "exam" ? "Exam" : "Quiz"),
      it.custom && h("span", { class: "badge added", title: "You added this item" }, "Added"),
      it.planner && h("span", { class: "badge added", title: "From your Class Planner schedule" }, "Planner")),
    h("td", { class: "c-course" },
      h("span", { class: "course-tag", style: { "--c": colors[it.course] || "#888" }, title: it.course },
        h("span", { class: "sw" }), shortCourse(it.course))),
    h("td", { class: "c-type" }, TYPE_LABEL[it.kind] || "Item"),
    h("td", { class: "c-left" }, h("span", { class: "pill " + left.cls }, left.text)),
    h("td", { class: "c-pct" }, share != null
      ? h("span", { class: share >= 10 ? "pct-hi" : "", title: "Share of your final grade" }, fmtPct(share))
      : h("span", { class: "pct-none" }, "—")),
    h("td", { class: "c-date" }, it.start ? `${fmtDay(it.start)} – ${fmtDay(it.due)}` : fmtDue(it.due)),
  );
}

function table(groups, colors, now) {
  const body = [];
  for (const [label, items, cls] of groups) {
    if (!items.length) continue;
    if (label) body.push(h("tr", { class: "group " + (cls || "") }, h("td", { colspan: 7 }, label, h("span", { class: "count" }, `(${items.length})`))));
    items.forEach((it, i) => body.push(row(it, colors, now, i % 2 === 1)));
  }
  if (!body.length) return h("div", { class: "empty" }, "Nothing here. You're all caught up 🎉");
  return h("table", { class: "tbl" },
    h("thead", {}, h("tr", {},
      h("th", { class: "c-check" }, h("span", { class: "sr" }, "")),
      h("th", {}, "Item"), h("th", {}, "Course"), h("th", {}, "Type"),
      h("th", {}, "Time Left"), h("th", { class: "c-pct" }, "% of Grade"), h("th", {}, "Due"))),
    h("tbody", {}, body));
}

function sortItems(list) {
  if (state.sort === "impact") {
    return list.sort((a, b) => (gradeShare(b) ?? -1) - (gradeShare(a) ?? -1) || a.due - b.due);
  }
  return list.sort((a, b) => a.due - b.due);
}

function doneSection(finished, colors, now) {
  if (!finished.length) return null;
  return h("details", { class: "done-section" },
    h("summary", {}, h("span", { class: "arrow" }, "▸"), `Completed (${finished.length})`),
    table([[null, finished.sort((a, b) => b.due - a.due)]], colors, now));
}

function renderList(active, finished, colors, now) {
  const overdue = active.filter(it => it.due < now && now - it.due < 3 * D);
  const soon = active.filter(it => it.due >= now && it.due - now < 3 * D);
  const week = active.filter(it => it.due - now >= 3 * D && it.due - now < 7 * D);
  const later = active.filter(it => it.due - now >= 7 * D);
  return [
    table([
      ["Overdue", sortItems(overdue), "over"],
      ["Next 3 days", sortItems(soon)],
      ["This week", sortItems(week)],
      ["Later", sortItems(later)],
    ], colors, now),
    doneSection(finished, colors, now),
  ];
}

function renderExams(active, finished, colors, now) {
  const upcoming = active.filter(it => isExam(it) && it.due >= now).sort((a, b) => (a.start || a.due) - (b.start || b.due));
  return [
    table([["Upcoming exams & quizzes", upcoming]], colors, now),
    doneSection(finished.filter(isExam), colors, now),
  ];
}

function renderCalendar(visible, colors, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + state.weekOffset * 7);
  const days = [...Array(7)].map((_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const end = new Date(days[6]); end.setHours(23, 59, 59, 999);

  const nav = h("div", { class: "cal-nav" },
    h("button", { class: "btn small", onclick: () => { state.weekOffset--; render(); } }, "‹ Prev"),
    h("button", { class: "btn small", onclick: () => { state.weekOffset = 0; render(); } }, "This week"),
    h("button", { class: "btn small", onclick: () => { state.weekOffset++; render(); } }, "Next ›"),
    h("span", { class: "range" }, `${fmtDay(days[0])} – ${fmtDay(days[6])}`),
  );

  const cols = days.map(day => {
    const dayStart = day.getTime(), dayEnd = dayStart + D - 1;
    const onDay = visible
      .filter(it => it.start ? it.start <= dayEnd && it.due >= dayStart : it.due >= dayStart && it.due <= dayEnd)
      .sort((a, b) => (isAllDay(a.due) - isAllDay(b.due)) || a.due - b.due);
    const isToday = dayStart === today.getTime();
    const wk = day.getDay() === 0 || day.getDay() === 6;
    return h("div", { class: "cal-day" + (isToday ? " today" : "") + (wk ? " weekend" : "") },
      h("div", { class: "cal-head" },
        day.toLocaleDateString(undefined, { weekday: "short" }),
        h("span", { class: "d" }, day.toLocaleDateString(undefined, { month: "numeric", day: "numeric" }))),
      h("div", { class: "cal-body" },
        onDay.length ? onDay.map(it => {
          const inWindow = it.start && !(it.due >= dayStart && it.due <= dayEnd);
          const tm = it.start ? (inWindow ? "window open" : "window closes") : isAllDay(it.due) ? "due today" : fmtTime(it.due);
          return h("div", {
              class: "cal-item" + (it.custom ? " added" : "") + (isExam(it) ? " exam" : "") + (it.start ? " window" : "") + (state.done.has(it.uid) ? " done" : ""),
              style: { "--c": colors[it.course] || "#888" },
            },
            h("span", { class: "tm" }, tm),
            titleEl(it),
            h("span", { class: "cn" }, shortCourse(it.course)));
        }) : h("div", { class: "cal-none" }, "—")),
    );
  });
  return [nav, h("div", { class: "cal" }, cols)];
}

function renderFilters(colors) {
  const courses = [...new Set(state.items.map(i => i.course))].sort();
  $("#filters").replaceChildren(...courses.map(c => {
    const on = !state.hidden.has(c);
    return h("label", { class: "cf" + (on ? "" : " off"), style: { "--c": colors[c] }, title: c },
      h("input", { type: "checkbox", checked: on, onchange: () => {
        on ? state.hidden.add(c) : state.hidden.delete(c);
        store.set("hidden", [...state.hidden]);
        render();
      } }),
      h("span", { class: "sw" }), shortCourse(c));
  }));
}

function render() {
  const connected = state.items.length > 0 || store.get("ics", null) != null;
  $("#setup").hidden = connected;
  $("#tracker").hidden = !connected;
  $("#subbar").hidden = !connected;
  if (!connected) return;

  const colors = courseColors();
  renderFilters(colors);
  document.querySelectorAll(".tabs button").forEach(b => {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", on);
  });
  $("#sort").value = state.sort;
  $("#sort-wrap").hidden = state.tab !== "list";

  const now = Date.now();
  const visible = state.items.filter(it =>
    !state.hidden.has(it.course) && (state.showEvents || it.kind !== "event"));  // "event-lite" = shown, not an exam
  const active = visible.filter(it => !state.done.has(it.uid));
  const finished = visible.filter(it => state.done.has(it.uid) && now - it.due < 14 * D);

  $("#s-24").textContent = active.filter(it => it.due >= now && it.due - now < D).length;
  $("#s-week").textContent = active.filter(it => it.due >= now && it.due - now < 7 * D).length;
  $("#s-exam").textContent = active.filter(it => it.due >= now && isExam(it)).length;

  renderNextClassHud(now);
  $("#filterbar").hidden = state.tab === "schedule";
  const board = state.tab === "schedule" ? renderSchedule(colors, now)
    : state.tab === "calendar" ? renderCalendar(visible, colors, now)
    : state.tab === "exams" ? renderExams(active, finished, colors, now)
    : renderList(active, finished, colors, now);
  $("#board").replaceChildren(...board.filter(Boolean));
  renderStatus();
}

function renderStatus(msg) {
  const at = store.get("fetchedAt", null);
  const src = store.get("feedUrl", null) ? "Synced with Canvas"
    : store.get("demo", false) ? "Showing sample data. Open Settings → Disconnect to use your own" : "Loaded from uploaded file";
  $("#status").textContent = msg || (at ? `${src} · ${new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "");
}

// ---------- Loading data ----------

function loadIcs(text, { save = true } = {}) {
  const items = parseIcs(text);
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error("That file isn't a calendar (.ics) file.");
  state.feedItems = items;
  rebuildItems();
  if (save) { store.set("ics", text); store.set("fetchedAt", Date.now()); }
  render();
}

// Hand-added items live alongside the feed and use the same shape.
function customToItem(c) {
  return { uid: c.id, title: c.title, course: c.course, due: c.due, link: null, kind: c.kind, custom: true };
}
function rebuildItems() {
  state.items = [...state.feedItems, ...state.custom.map(customToItem), ...scheduleExamItems()];
}

async function fetchFeed(url) {
  const res = await fetch("/api/feed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(body || "Couldn't reach Canvas.");
  return body;
}

async function refresh({ quiet = false } = {}) {
  const url = store.get("feedUrl", null);
  if (!url) return;
  const btn = $("#btn-refresh");
  btn.classList.add("spin");
  if (!quiet) renderStatus("Syncing with Canvas…");
  try {
    loadIcs(await fetchFeed(url));
  } catch (e) {
    renderStatus(`Couldn't sync: ${e.message}`);
  } finally {
    btn.classList.remove("spin");
  }
}

// ---------- Setup ----------

function applyHost() {
  const host = state.host || CFG.canvasHost;
  $("#canvas-cal-link").href = `https://${host}/calendar`;
  $("#feed-input").placeholder = `https://${host}/feeds/calendars/user_….ics`;
}

$("#feed-form").addEventListener("submit", async e => {
  e.preventDefault();
  const url = $("#feed-input").value.trim();
  const err = $("#setup-error");
  err.textContent = "";
  if (!/^https:\/\/[^/]+\/feeds\/calendars\/[\w-]+\.ics$/.test(url)) {
    err.textContent = "That doesn't look like a Canvas feed link. It should end in .ics and contain /feeds/calendars/.";
    return;
  }
  const btn = e.submitter || $("#feed-form button");
  btn.disabled = true; btn.textContent = "Connecting…";
  try {
    const text = await fetchFeed(url);
    store.set("feedUrl", url); store.set("demo", false);
    state.host = new URL(url).host; store.set("host", state.host);
    $("#feed-input").value = "";
    loadIcs(text);
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    btn.disabled = false; btn.textContent = "Connect";
  }
});

function readFile(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try { store.set("feedUrl", null); store.set("demo", false); loadIcs(String(r.result)); $("#setup-error").textContent = ""; }
    catch (ex) { $("#setup-error").textContent = ex.message; }
  };
  r.readAsText(file);
}
$("#file-input").addEventListener("change", e => readFile(e.target.files[0]));
const drop = $(".upload");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("drag"); });
drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("drag"); readFile(e.dataTransfer.files[0]); });

$("#change-school").addEventListener("click", openSettings);

// Demo data with dates relative to now, so the countdowns always look realistic.
function demoIcs() {
  const now = Date.now();
  const stamp = t => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const ev = [
    ["Quiz 4: Derivatives", "MATH 20A - Calculus for Science & Engr", 3.2 * H],
    ["Lab Report: Cell Respiration", "BILD 1 - The Cell", 9.7 * H],
    ["Reading Response 5", "HIST 7A - American History", 20 * H],
    ["Essay Draft: Argument", "CAT 1 - Culture, Art & Technology", 3 * D],
    ["Midterm Exam", "CHEM 6A - General Chemistry", 4.1 * D],
    ["Problem Set 6", "MATH 20A - Calculus for Science & Engr", 5.5 * D],
    ["Chapter 7 Quiz", "BILD 1 - The Cell", 9 * D],
    ["Primary Source Analysis", "HIST 7A - American History", 12 * D],
    ["Final Exam", "CHEM 6A - General Chemistry", 60 * D],
    ["Midterm 1", "CHEM 6A - General Chemistry", -20 * D],
    ["Problem Set 5", "MATH 20A - Calculus for Science & Engr", -2 * D],
  ];
  // A multi-day testing window posted as one calendar event per day (merged into one card)
  const day = t => { const d = new Date(t); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; };
  const windowDays = [2, 3, 4, 5, 6].map((n, i) => [
    "BEGIN:VEVENT", `UID:event-calendar-event-demo${i}`, `DTSTART;VALUE=DATE:${day(now + n * D)}`,
    "SUMMARY:Test 1 - Testing window [CSE 20 - Discrete Mathematics]", "END:VEVENT",
  ]);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...ev.flatMap(([t, c, off], i) => [
    "BEGIN:VEVENT", `UID:event-assignment-demo${i}`, `DTSTART:${stamp(now + off)}`, `SUMMARY:${t} [${c}]`, "END:VEVENT",
  ]), ...windowDays.flat(), "END:VCALENDAR"].join("\r\n");
}
$("#try-demo").addEventListener("click", () => {
  store.set("feedUrl", null); store.set("demo", true);
  state.weights["CHEM 6A - General Chemistry"] ||= [
    { name: "Midterms", weight: 40, kw: "midterm", count: "" },
    { name: "Final", weight: 45, kw: "final", count: "" },
    { name: "Homework", weight: 15, kw: "homework", count: "" },
  ];
  saveWeights();
  loadIcs(demoIcs());
});

// ---------- Toolbar ----------

$("#sort").addEventListener("change", e => { state.sort = e.target.value; store.set("sort", state.sort); render(); });
document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
  state.tab = b.dataset.tab; store.set("tab", state.tab); render();
}));
$("#btn-refresh").addEventListener("click", () => {
  if (store.get("feedUrl", null)) refresh();
  else $("#file-input").click();
});
$("#btn-settings").addEventListener("click", openSettings);
$("#btn-weights").addEventListener("click", openWeights);

// ---------- Settings dialog ----------

function openSettings() {
  $("#set-host").value = state.host || CFG.canvasHost;
  $("#set-events").checked = state.showEvents;
  $("#set-disconnect").hidden = $("#tracker").hidden;
  $("#settings-dlg").showModal();
}
$("#set-save").addEventListener("click", () => {
  const host = $("#set-host").value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (host) { state.host = host; store.set("host", host); }
  state.showEvents = $("#set-events").checked; store.set("showEvents", state.showEvents);
  applyHost(); render();
});
$("#set-disconnect").addEventListener("click", () => {
  if (!confirm("Forget your feed link, checked-off items and grade weights on this browser?")) return;
  store.clear();
  Object.assign(state, { items: [], feedItems: [], custom: [], schedule: null, scheduleError: null, done: new Set(), hidden: new Set(), weights: {}, sort: "due", tab: "list", weekOffset: 0, host: CFG.canvasHost, showEvents: false });
  $("#settings-dlg").close();
  applyHost(); render();
});

// ---------- Weights dialog ----------

const TEMPLATE = [
  { name: "Homework", weight: 25, kw: "homework, hw, problem set, pset, assignment" },
  { name: "Quizzes", weight: 15, kw: "quiz" },
  { name: "Midterms", weight: 30, kw: "midterm, mid-term" },
  { name: "Final exam", weight: 30, kw: "final" },
];

function openWeights() {
  const courses = [...new Set(state.items.map(i => i.course))].sort();
  const sel = $("#w-course");
  const prev = sel.value;
  sel.replaceChildren(...courses.map(c => h("option", { value: c }, c)));
  if (courses.includes(prev)) sel.value = prev;
  renderWeightRows();
  $("#weights-dlg").showModal();
}

function saveWeights() { store.set("weights", state.weights); }

function renderWeightRows() {
  const course = $("#w-course").value;
  const cats = state.weights[course] || (state.weights[course] = []);
  const rows = [h("div", { class: "w-row w-head" }, h("span", {}, "Category"), h("span", {}, "Weight %"), h("span", {}, "Title keywords"), h("span", {}, "# items"), h("span", {}))];

  cats.forEach((c, i) => {
    const matched = state.items.filter(it => it.course === course && categoryFor(it) === c).length;
    const onInput = (key, num) => e => { c[key] = num ? e.target.value : e.target.value; saveWeights(); updateTotal(); if (key !== "name") updateHints(); };
    rows.push(h("div", { class: "w-row" },
      h("input", { type: "text", value: c.name || "", placeholder: "Exams", "aria-label": "Category name", oninput: onInput("name") }),
      h("input", { type: "number", min: 0, max: 100, step: "any", value: c.weight ?? "", placeholder: "%", "aria-label": "Weight percent", oninput: onInput("weight", true) }),
      h("input", { class: "kw", type: "text", value: c.kw || "", placeholder: "midterm, exam", "aria-label": "Title keywords", oninput: onInput("kw") }),
      h("input", { class: "cnt", type: "number", min: 0, step: 1, value: c.count || "", placeholder: "auto", title: "Leave blank to count matching items automatically", "aria-label": "Number of items", oninput: onInput("count", true) }),
      h("button", { type: "button", class: "rm", "aria-label": "Remove category", onclick: () => { cats.splice(i, 1); saveWeights(); renderWeightRows(); } }, "×"),
      h("div", { class: "w-hint", "data-i": i }, hintText(c, matched)),
    ));
  });
  $("#w-rows").replaceChildren(...rows);
  updateTotal();
}

function hintText(c, matched) {
  const n = +c.count > 0 ? +c.count : matched;
  const each = n && +c.weight > 0 ? ` → ${fmtPct(+c.weight / n)} each` : "";
  return `${matched} item${matched === 1 ? "" : "s"} in Canvas match${matched === 1 ? "es" : ""}${+c.count > 0 ? ` (using ${c.count})` : ""}${each}`;
}

function updateHints() {
  const course = $("#w-course").value;
  const cats = state.weights[course] || [];
  document.querySelectorAll(".w-hint").forEach(el => {
    const c = cats[+el.dataset.i];
    if (c) el.textContent = hintText(c, state.items.filter(it => it.course === course && categoryFor(it) === c).length);
  });
}

function updateTotal() {
  const cats = state.weights[$("#w-course").value] || [];
  const total = cats.reduce((s, c) => s + (+c.weight || 0), 0);
  const el = $("#w-total");
  el.textContent = cats.length ? `Total: ${+total.toFixed(2)}%` : "";
  el.className = "w-total " + (Math.abs(total - 100) < 0.01 ? "ok" : cats.length ? "bad" : "");
}

$("#w-course").addEventListener("change", renderWeightRows);
$("#w-add").addEventListener("click", () => {
  const course = $("#w-course").value;
  (state.weights[course] ||= []).push({ name: "", weight: "", kw: "", count: "" });
  saveWeights(); renderWeightRows();
});
$("#w-preset").addEventListener("click", () => {
  const course = $("#w-course").value;
  if ((state.weights[course] || []).length && !confirm("Replace this course's categories with the template?")) return;
  state.weights[course] = TEMPLATE.map(c => ({ ...c, count: "" }));
  saveWeights(); renderWeightRows();
});
$("#weights-dlg").addEventListener("close", render);

// ---------- Class schedule (UCSD Class Planner) ----------

const DAY_NAMES = { M: "Mon", T: "Tue", W: "Wed", R: "Thu", F: "Fri", S: "Sat", U: "Sun" };
const DAY_ORDER = ["M", "T", "W", "R", "F", "S", "U"];
const JS_DAY = { 0: "U", 1: "M", 2: "T", 3: "W", 4: "R", 5: "F", 6: "S" };
const fmtMin = m => {
  const h = Math.floor(m / 60), mm = m % 60, ap = h >= 12 ? "pm" : "am";
  return `${(h % 12) || 12}:${String(mm).padStart(2, "0")}${ap}`;
};
const fmtRange = (a, b) => `${fmtMin(a)}–${fmtMin(b)}`;
const mapsUrl = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;

async function fetchSchedule(url) {
  const res = await fetch("/api/schedule", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(body || "Couldn't reach Class Planner.");
  return JSON.parse(body);
}

async function refreshSchedule({ quiet = true } = {}) {
  const url = store.get("plannerUrl", null);
  if (!url) return;
  try {
    state.schedule = await fetchSchedule(url);
    store.set("schedule", state.schedule);
    rebuildItems(); render();
  } catch (e) {
    if (!quiet) state.scheduleError = e.message, render();
  }
}

// Match a schedule course ("CSE 20") to the Canvas course name, so colors and exams line up.
function feedCourseFor(short) {
  return [...new Set(state.feedItems.map(i => i.course))].find(c => shortCourse(c) === short) || null;
}
function scheduleColor(short, colors) {
  const feed = feedCourseFor(short);
  if (feed && colors[feed]) return colors[feed];
  const courses = [...new Set((state.schedule?.sections || []).map(s => s.course))].sort();
  return PALETTE[(courses.indexOf(short) + 3) % PALETTE.length];
}

// Midterms/finals from Class Planner become tracker items (unless Canvas already lists them).
function scheduleExamItems() {
  const sch = state.schedule;
  if (!sch) return [];
  return sch.exams.flatMap(ex => {
    const [y, mo, d] = ex.date.split("-").map(Number);
    const start = ex.start ?? 0;
    const due = new Date(y, mo - 1, d, Math.floor(start / 60), start % 60).getTime();
    const course = feedCourseFor(ex.course) || ex.course;
    const dayStart = new Date(y, mo - 1, d).getTime();
    const dup = state.feedItems.some(i => i.kind === "exam" && shortCourse(i.course) === ex.course &&
      i.due >= dayStart && i.due < dayStart + D);
    if (dup) return [];
    return [{
      uid: `planner-${ex.course}-${ex.kind}-${ex.date}`.replace(/\s+/g, "_"),
      title: `${ex.kind === "Final" ? "Final Exam" : ex.kind}${ex.location ? ` · ${ex.location}` : ""}`,
      course, due, link: null, kind: "exam", planner: true,
    }];
  });
}

function nextClass(now = Date.now()) {
  const sch = state.schedule;
  if (!sch || !sch.meetings.length) return null;
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
  for (let i = 0; i < 7; i++) {
    const day = new Date(d0); day.setDate(d0.getDate() + i);
    const code = JS_DAY[day.getDay()];
    const nowMin = i === 0 ? new Date(now).getHours() * 60 + new Date(now).getMinutes() : -1;
    const todays = sch.meetings.filter(m => m.day === code && m.end > nowMin).sort((a, b) => a.start - b.start);
    if (todays.length) {
      const m = todays[0];
      const inProgress = i === 0 && m.start <= nowMin;
      return { m, when: i === 0 ? (inProgress ? "now" : "today") : i === 1 ? "tomorrow" : DAY_NAMES[code] };
    }
  }
  return null;
}

// Assign side-by-side lanes to overlapping meetings within one day.
function layoutDay(list) {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let group = [], groupEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const m of group) {
      let lane = lanes.findIndex(end => end <= m.start);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = m.end;
      out.push({ m, lane });
    }
    for (const o of out.slice(-group.length)) { o.lanes = lanes.length; o.conflict = lanes.length > 1; }
  };
  for (const m of sorted) {
    if (group.length && m.start >= groupEnd) { flush(); group = []; groupEnd = -1; }
    group.push(m); groupEnd = Math.max(groupEnd, m.end);
  }
  if (group.length) flush();
  return out;
}

function scheduleConnectForm() {
  const input = h("input", { type: "url", placeholder: "https://classplanner.apps.ucsd.edu/view/CS2…", autocomplete: "off", spellcheck: "false", required: true });
  const err = h("div", { class: "error", role: "alert" }, state.scheduleError || "");
  const btn = h("button", { class: "btn primary", type: "submit" }, "Load schedule");
  const form = h("form", { class: "feed-form", onsubmit: async e => {
    e.preventDefault();
    err.textContent = ""; btn.disabled = true; btn.textContent = "Loading…";
    try {
      const url = input.value.trim();
      state.schedule = await fetchSchedule(url);
      store.set("plannerUrl", url); store.set("schedule", state.schedule);
      state.scheduleError = null;
      rebuildItems(); render();
    } catch (ex) {
      err.textContent = ex.message;
    } finally { btn.disabled = false; btn.textContent = "Load schedule"; }
  } },
    h("label", { class: "lbl" }, "Class Planner share link"),
    h("div", { class: "feed-row" }, input, btn));
  return h("div", { class: "sched-connect" },
    h("h3", {}, "Add your class schedule"),
    h("p", { class: "muted" }, "See your weekly classes with times, rooms and professors, a campus map, walking times between classes, and your midterms and finals as countdowns."),
    h("ol", { class: "steps" },
      h("li", {}, "Open ", h("a", { href: "https://classplanner.apps.ucsd.edu/", target: "_blank", rel: "noopener" }, "Class Planner"), " and open your schedule."),
      h("li", {}, "Click ", h("b", {}, "Save & share"), " and copy the link."),
      h("li", {}, "Paste it below.")),
    form, err);
}

// Keep one map alive across re-renders so panning isn't reset every minute.
// Tiles: OpenFreeMap (free, no API key, OpenStreetMap data) rendered with MapLibre GL.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
const MAPLIBRE = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/4.7.1/maplibre-gl.min";
const mapState = { el: null, map: null, markers: [], key: "", pts: [], fitted: false };
let mapLibPromise = null;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve(window.maplibregl);
  return mapLibPromise ||= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = MAPLIBRE + ".css";
    document.head.append(css);
    const js = document.createElement("script");
    js.src = MAPLIBRE + ".js";
    js.onload = () => resolve(window.maplibregl); js.onerror = reject;
    document.head.append(js);
  });
}

function scheduleMap(sch, colors) {
  if (!mapState.el) mapState.el = h("div", { class: "sched-map", role: "region", "aria-label": "Map of your class buildings" });
  const key = JSON.stringify(sch.locations) + JSON.stringify(sch.sections.map(s => s.course));
  loadMapLibre().then(ml => {
    if (!mapState.map) {
      mapState.map = new ml.Map({
        container: mapState.el, style: MAP_STYLE,
        center: [-117.2376, 32.8801], zoom: 15,
        cooperativeGestures: true,           // don't hijack page scrolling
        attributionControl: { compact: true },
      });
      mapState.map.addControl(new ml.NavigationControl({ showCompass: false }), "top-left");
    }
    if (mapState.key !== key) {
      mapState.key = key;
      mapState.markers.forEach(m => m.remove());
      mapState.markers = [];
      mapState.pts = [];
      for (const loc of sch.locations) {
        const here = sch.sections.filter(s => s.meetings.some(m => m.buildingCode === loc.code));
        const color = here.length ? scheduleColor(here[0].course, colors) : "#182B49";
        const pin = h("div", { class: "map-pin", style: { "--c": color }, title: loc.name },
          h("span", { class: "dot" }), h("span", { class: "tag" }, loc.code));
        const popup = h("div", { class: "map-pop" },
          h("b", {}, loc.name), h("br"),
          ...here.flatMap(s => [`${s.course} ${s.type} · ${[...new Set(s.meetings.filter(m => m.buildingCode === loc.code).map(m => m.room))].join(", ")}`, h("br")]),
          h("a", { href: mapsUrl(`${loc.lat},${loc.lng}`), target: "_blank", rel: "noopener" }, "Directions ↗"));
        mapState.markers.push(new ml.Marker({ element: pin, anchor: "left", offset: [-7, 0] })
          .setLngLat([loc.lng, loc.lat])
          .setPopup(new ml.Popup({ offset: 12, closeButton: true }).setDOMContent(popup))
          .addTo(mapState.map));
        mapState.pts.push([loc.lng, loc.lat]);
      }
      mapState.fitted = false;
    }
    // Size and fit only once the container is on the page and laid out.
    requestAnimationFrame(() => {
      if (!mapState.el.isConnected || !mapState.el.clientHeight) return;
      mapState.map.resize();
      if (!mapState.fitted && mapState.pts.length) {
        const b = new ml.LngLatBounds(mapState.pts[0], mapState.pts[0]);
        mapState.pts.forEach(p => b.extend(p));
        mapState.map.fitBounds(b, { padding: 50, maxZoom: 16.5, duration: 0 });
        mapState.fitted = true;
      }
    });
  }).catch(() => { mapState.el.textContent = "Map couldn't load."; });
  return mapState.el;
}

function renderSchedule(colors, now) {
  const sch = state.schedule;
  if (!sch) return [scheduleConnectForm()];

  const courses = [...new Set(sch.sections.map(s => s.course))];
  const days = DAY_ORDER.filter(d => ["M", "T", "W", "R", "F"].includes(d) || sch.meetings.some(m => m.day === d));
  const minStart = Math.min(...sch.meetings.map(m => m.start), 8 * 60);
  const maxEnd = Math.max(...sch.meetings.map(m => m.end), 17 * 60);
  const startH = Math.floor(minStart / 60), endH = Math.ceil(maxEnd / 60);
  const PX = 1.1; // pixels per minute
  const todayCode = JS_DAY[new Date(now).getDay()];
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  let conflicts = 0;

  const head = h("div", { class: "sched-head" },
    h("div", {},
      h("div", { class: "sched-title" }, `${sch.term} schedule`),
      h("div", { class: "muted small" }, `${courses.join(", ")} · ${sch.sections.length} sections`)),
    h("div", { class: "sched-actions" },
      h("a", { class: "btn small", href: sch.shareUrl, target: "_blank", rel: "noopener" }, "Open in Class Planner ↗"),
      h("button", { class: "btn small", onclick: () => refreshSchedule({ quiet: false }) }, "Refresh"),
      h("button", { class: "btn small danger", onclick: () => {
        if (!confirm("Remove your class schedule from this tracker?")) return;
        state.schedule = null; store.set("schedule", null); store.set("plannerUrl", null);
        rebuildItems(); render();
      } }, "Remove")));

  const nc = nextClass(now);
  const next = nc && h("div", { class: "sched-next", style: { "--c": scheduleColor(nc.m.course, colors) } },
    h("span", { class: "lbl" }, nc.when === "now" ? "In class now" : "Next class"),
    h("b", {}, `${nc.m.course} ${nc.m.type}`),
    ` ${nc.when === "now" || nc.when === "today" ? "" : nc.when + " "}${fmtRange(nc.m.start, nc.m.end)} · `,
    h("a", { href: mapsUrl(`${nc.m.building || nc.m.room} UC San Diego`), target: "_blank", rel: "noopener" }, nc.m.room || nc.m.building),
    nc.m.instructor ? ` · ${nc.m.instructor}` : "");

  // Week grid
  const hours = [];
  for (let hh = startH; hh <= endH; hh++) hours.push(hh);
  const gridH = (endH - startH) * 60 * PX;
  const grid = h("div", { class: "wk", style: { "--cols": days.length } },
    h("div", { class: "wk-corner" }),
    ...days.map(d => h("div", { class: "wk-dayhead" + (d === todayCode ? " today" : "") }, DAY_NAMES[d])),
    h("div", { class: "wk-hours", style: { height: gridH + "px" } },
      ...hours.slice(0, -1).map(hh => h("div", { class: "wk-hour", style: { top: (hh - startH) * 60 * PX + "px" } }, fmtMin(hh * 60).replace(":00", "")))),
    ...days.map(d => {
      const laid = layoutDay(sch.meetings.filter(m => m.day === d));
      conflicts += laid.filter(o => o.conflict).length;
      return h("div", { class: "wk-col" + (d === todayCode ? " today" : ""), style: { height: gridH + "px" } },
        ...hours.slice(0, -1).map(hh => h("div", { class: "wk-line", style: { top: (hh - startH) * 60 * PX + "px" } })),
        d === todayCode && nowMin > startH * 60 && nowMin < endH * 60 && h("div", { class: "wk-now", style: { top: (nowMin - startH * 60) * PX + "px" } }),
        ...laid.map(({ m, lane, lanes, conflict }) => h("div", {
          class: "wk-block" + (conflict ? " conflict" : ""),
          style: {
            "--c": scheduleColor(m.course, colors),
            top: (m.start - startH * 60) * PX + "px", height: Math.max(22, (m.end - m.start) * PX - 2) + "px",
            left: `calc(${(100 / lanes) * lane}% + 2px)`, width: `calc(${100 / lanes}% - 4px)`,
          },
          title: `${m.course} ${m.type} ${fmtRange(m.start, m.end)} · ${m.room} · ${m.instructor}${conflict ? " · TIME CONFLICT" : ""}`,
        },
          h("b", {}, `${m.course} `, h("span", { class: "ty" }, m.type)),
          h("span", {}, fmtRange(m.start, m.end)),
          h("span", {}, m.remote ? "Remote" : m.tba ? "TBA" : m.room),
          h("span", { class: "ins" }, m.instructor))));
    }));

  // Phone-friendly day list (shown instead of the grid on small screens)
  const dayList = h("div", { class: "wk-list" }, ...days.filter(d => sch.meetings.some(m => m.day === d)).map(d =>
    h("div", { class: "wk-list-day" + (d === todayCode ? " today" : "") },
      h("div", { class: "wk-list-head" }, DAY_NAMES[d]),
      ...sch.meetings.filter(m => m.day === d).sort((a, b) => a.start - b.start).map(m =>
        h("div", { class: "wk-list-item", style: { "--c": scheduleColor(m.course, colors) } },
          h("span", { class: "tm" }, fmtRange(m.start, m.end)),
          h("b", {}, `${m.course} ${m.type}`),
          h("span", { class: "muted" }, ` · ${m.room} · ${m.instructor}`))))));

  // Walking between back-to-back classes
  const walks = sch.walks.filter(w => w.gapMinutes < 60 && w.from.loc !== w.to.loc || w.gapMinutes < 0);
  const walkTable = walks.length ? h("table", { class: "tbl walk-tbl" },
    h("thead", {}, h("tr", {}, h("th", {}, "Day"), h("th", {}, "From → To"), h("th", {}, "Walk"), h("th", {}, "Time between"), h("th", {}, ""))),
    h("tbody", {}, walks.map((w, i) => {
      const st = w.gapMinutes < 0 ? ["Overlap", "u-late"] : w.walkMinutes >= w.gapMinutes ? ["Tight", "u-red"] : w.walkMinutes >= w.gapMinutes - 3 ? ["Close", "u-orange"] : ["OK", "u-green"];
      return h("tr", { class: "row" + (i % 2 ? " alt" : "") },
        h("td", {}, DAY_NAMES[w.day]),
        h("td", {}, `${w.from.course} ${w.from.type} (${w.from.loc}) → ${w.to.course} ${w.to.type} (${w.to.loc})`),
        h("td", {}, w.gapMinutes < 0 ? "—" : `${w.walkMinutes} min · ${w.meters} m`),
        h("td", {}, w.gapMinutes < 0 ? `overlaps ${-w.gapMinutes} min` : `${w.gapMinutes} min`),
        h("td", {}, h("span", { class: "pill " + st[1] }, st[0])));
    }))) : h("div", { class: "empty" }, "No back-to-back classes in different buildings.");

  // Class details
  const details = h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, h("th", {}, "Course"), h("th", {}, "Type"), h("th", {}, "Section"), h("th", {}, "Days & time"), h("th", {}, "Location"), h("th", {}, "Instructor"))),
    h("tbody", {}, sch.sections.sort((a, b) => a.course.localeCompare(b.course) || a.type.localeCompare(b.type)).map((s, i) => {
      const slots = new Map();
      for (const m of s.meetings) {
        const k = `${m.start}-${m.end}|${m.room}`;
        (slots.get(k) || slots.set(k, { m, days: [] }).get(k)).days.push(m.day);
      }
      const rows = [...slots.values()];
      return h("tr", { class: "row" + (i % 2 ? " alt" : "") },
        h("td", {}, h("span", { class: "course-tag", style: { "--c": scheduleColor(s.course, colors) } }, h("span", { class: "sw" }), h("b", {}, s.course)),
          h("div", { class: "muted small" }, s.title)),
        h("td", {}, s.type),
        h("td", { class: "mono" }, s.code),
        h("td", {}, ...rows.flatMap(({ m, days }) => [
          `${days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b)).map(d => DAY_NAMES[d]).join(", ")} ${fmtRange(m.start, m.end)}`, h("br")])),
        h("td", {}, ...rows.flatMap(({ m }) => [m.remote ? "Remote" : m.tba ? "TBA"
          : h("a", { href: mapsUrl(`${m.building || m.room} UC San Diego`), target: "_blank", rel: "noopener", title: m.building }, `${m.room}`),
          m.building ? h("span", { class: "muted small" }, ` ${m.building}`) : "", h("br")])),
        h("td", {}, s.instructor || "Staff"));
    })));

  // Exams
  const exams = [...sch.exams].sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
  const examTable = exams.length ? h("table", { class: "tbl" },
    h("thead", {}, h("tr", {}, h("th", {}, "Exam"), h("th", {}, "Course"), h("th", {}, "Date"), h("th", {}, "Time"), h("th", {}, "Location"), h("th", {}, "Countdown"))),
    h("tbody", {}, exams.map((ex, i) => {
      const [y, mo, d] = ex.date.split("-").map(Number);
      const at = new Date(y, mo - 1, d, Math.floor((ex.start ?? 0) / 60), (ex.start ?? 0) % 60).getTime();
      const ms = at - now;
      const cls = ms < 0 ? "done-pill" : ms < D ? "u-red" : ms < 3 * D ? "u-orange" : ms < 7 * D ? "u-blue" : "u-green";
      return h("tr", { class: "row exam" + (i % 2 ? " alt" : "") },
        h("td", {}, h("b", {}, ex.kind)),
        h("td", {}, h("span", { class: "course-tag", style: { "--c": scheduleColor(ex.course, colors) } }, h("span", { class: "sw" }), ex.course)),
        h("td", {}, new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })),
        h("td", {}, ex.start != null ? fmtRange(ex.start, ex.end) : ex.time),
        h("td", {}, ex.location ? h("a", { href: mapsUrl(`${ex.location} UC San Diego`), target: "_blank", rel: "noopener" }, ex.location) : "TBA"),
        h("td", {}, h("span", { class: "pill " + cls }, ms < 0 ? "done" : fmtSpan(ms))));
    }))) : h("div", { class: "empty" }, "No midterms or finals listed yet.");

  return [
    h("div", { class: "sched" },
      head,
      state.scheduleError && h("div", { class: "error" }, state.scheduleError),
      next,
      conflicts > 0 && h("div", { class: "sched-warn" }, "⚠ This schedule has overlapping classes (shown in red)."),
      h("h4", { class: "sched-h" }, "Weekly schedule"),
      grid, dayList,
      h("div", { class: "sched-two" },
        h("div", {}, h("h4", { class: "sched-h" }, "Where your classes are"), scheduleMap(sch, colors)),
        h("div", {}, h("h4", { class: "sched-h" }, "Walking between classes"), walkTable)),
      h("h4", { class: "sched-h" }, "Class details"), details,
      h("h4", { class: "sched-h" }, "Midterms & finals"), examTable,
      h("p", { class: "fine" }, `From UCSD Class Planner · updated ${new Date(sch.fetchedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}. Midterms and finals also appear in your List and Exams tabs.`)),
  ];
}

function renderNextClassHud(now) {
  const el = $("#s-next");
  const nc = nextClass(now);
  el.hidden = !nc;
  if (!nc) return;
  el.replaceChildren(
    nc.when === "now" ? "In class: " : "Next class: ",
    h("b", {}, `${nc.m.course} ${nc.m.type}`),
    ` ${nc.when === "now" || nc.when === "today" ? "" : nc.when + " "}${fmtMin(nc.m.start)} · ${nc.m.room}`);
}

// ---------- Add / edit item dialog ----------

const pad = n => String(n).padStart(2, "0");
const dateVal = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeVal = t => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
let editingId = null, kindTouched = false;

function fillCourseOptions(selected) {
  const courses = [...new Set(state.items.map(i => i.course))].sort();
  const sel = $("#i-course");
  sel.replaceChildren(
    ...courses.map(c => h("option", { value: c }, shortCourse(c) === c ? c : `${shortCourse(c)} (${c})`)),
    h("option", { value: "__new" }, "+ New course…"));
  sel.value = selected && courses.includes(selected) ? selected : courses[0] || "__new";
  if (selected && !courses.includes(selected)) { sel.value = "__new"; $("#i-course-new").value = selected; }
  $("#i-course-new-wrap").hidden = sel.value !== "__new";
}

function openItem(id = null) {
  editingId = id;
  const c = id ? state.custom.find(x => x.id === id) : null;
  $("#item-title").textContent = c ? "Edit Item" : "Add Item";
  $("#i-title").value = c ? c.title : "";
  $("#i-course-new").value = "";
  fillCourseOptions(c ? c.course : null);
  $("#i-kind").value = c ? c.kind : "assignment";
  const due = c ? c.due : null;
  $("#i-date").value = due ? dateVal(due) : dateVal(Date.now() + D);
  $("#i-time").value = due ? timeVal(due) : "23:59";
  $("#i-delete").hidden = !c;
  $("#i-error").textContent = "";
  kindTouched = !!c;
  $("#item-dlg").showModal();
  $("#i-title").focus();
}

$("#i-course").addEventListener("change", e => {
  $("#i-course-new-wrap").hidden = e.target.value !== "__new";
  if (e.target.value === "__new") $("#i-course-new").focus();
});
$("#i-kind").addEventListener("change", () => { kindTouched = true; });
// Guess the type from the title until the user picks one themselves.
$("#i-title").addEventListener("input", e => {
  if (!kindTouched) $("#i-kind").value = kindOf(e.target.value, "assignment");
});

$("#i-save").addEventListener("click", e => {
  const title = $("#i-title").value.trim();
  const course = $("#i-course").value === "__new" ? $("#i-course-new").value.trim() : $("#i-course").value;
  const date = $("#i-date").value, time = $("#i-time").value || "23:59";
  const err = $("#i-error");
  if (!title) { e.preventDefault(); err.textContent = "Give it a name."; return; }
  if (!course) { e.preventDefault(); err.textContent = "Pick a course or type a new one."; return; }
  if (!date) { e.preventDefault(); err.textContent = "Pick a due date."; return; }
  const [y, mo, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  const due = new Date(y, mo - 1, d, hh, mm).getTime();
  const data = { title, course, kind: $("#i-kind").value, due };
  if (editingId) Object.assign(state.custom.find(x => x.id === editingId), data);
  else state.custom.push({ id: "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ...data });
  store.set("custom", state.custom);
  rebuildItems(); render();
});

$("#i-delete").addEventListener("click", () => {
  if (!editingId || !confirm("Delete this item?")) return;
  state.custom = state.custom.filter(x => x.id !== editingId);
  state.done.delete(editingId); store.set("done", [...state.done]);
  store.set("custom", state.custom);
  $("#item-dlg").close();
  rebuildItems(); render();
});

$("#btn-add").addEventListener("click", () => openItem());

// ---------- Boot ----------

document.title = CFG.appName;
$("#app-name").textContent = CFG.appName;
$("#foot-note").textContent = CFG.footNote;
$("#repo-link").href = CFG.repoUrl;
if (CFG.authorName) { $("#author-link").textContent = CFG.authorName; $("#author-link").href = CFG.authorUrl || CFG.repoUrl; }
else $(".made-by").remove();
document.documentElement.style.setProperty("--accent", CFG.accent);
document.documentElement.style.setProperty("--accent-ink", CFG.accentInk);
$("#today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
applyHost();

const cached = store.get("ics", null);
if (cached) { try { loadIcs(cached, { save: false }); } catch { render(); } }
else render();
refresh({ quiet: true });
refreshSchedule();

setInterval(render, 60e3);
setInterval(() => refresh({ quiet: true }), 30 * 60e3);
})();

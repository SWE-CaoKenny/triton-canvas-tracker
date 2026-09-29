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
      it.custom && h("span", { class: "badge added", title: "You added this item" }, "Added")),
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

  const board = state.tab === "calendar" ? renderCalendar(visible, colors, now)
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
  state.items = [...state.feedItems, ...state.custom.map(customToItem)];
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
  Object.assign(state, { items: [], feedItems: [], custom: [], done: new Set(), hidden: new Set(), weights: {}, sort: "due", tab: "list", weekOffset: 0, host: CFG.canvasHost, showEvents: false });
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
document.documentElement.style.setProperty("--accent", CFG.accent);
document.documentElement.style.setProperty("--accent-ink", CFG.accentInk);
$("#today").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
applyHost();

const cached = store.get("ics", null);
if (cached) { try { loadIcs(cached, { save: false }); } catch { render(); } }
else render();
refresh({ quiet: true });

setInterval(render, 60e3);
setInterval(() => refresh({ quiet: true }), 30 * 60e3);
})();

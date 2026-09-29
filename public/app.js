(() => {
"use strict";

const CFG = window.TRACKER_CONFIG;
const H = 3600e3, D = 24 * H;
const PALETTE = ["#4fd1c5", "#60a5fa", "#f472b6", "#fbbf24", "#a3e635", "#c084fc", "#fb7185", "#38bdf8", "#f97316", "#34d399"];

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
  host: store.get("host", CFG.canvasHost),
  showEvents: store.get("showEvents", false),
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
  if (EXAM_RE.test(title) && !/\b(final (project|paper|essay|report|draft))\b/i.test(title)) return "exam";
  if (QUIZ_RE.test(title)) return "quiz";
  if (/assignment/.test(uid)) return "assignment";
  return "event";
}

function shortCourse(full) {
  const m = full.match(/\b([A-Z]{2,5})\s?-?\s?(\d{1,3}[A-Z]{0,3})\b/);
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
  return [...seen.values()];
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
  const saved = store.get("colors", {});
  const used = new Set(Object.values(saved));
  let next = 0;
  for (const c of courses) {
    if (saved[c]) continue;
    while (used.has(PALETTE[next % PALETTE.length]) && next < PALETTE.length) next++;
    saved[c] = PALETTE[next % PALETTE.length];
    used.add(saved[c]); next++;
  }
  store.set("colors", saved);
  return saved;
}

// ---------- Rendering ----------

function urgency(ms) {
  if (ms < 0) return "var(--red)";
  if (ms < D) return "var(--red)";
  if (ms < 3 * D) return "var(--orange)";
  if (ms < 7 * D) return "var(--blue)";
  return "var(--green)";
}

function countdown(ms) {
  const late = ms < 0; ms = Math.abs(ms);
  const d = Math.floor(ms / D), hr = Math.floor(ms % D / H), m = Math.floor(ms % H / 60e3);
  let big, small = "";
  if (d >= 2) { big = `${d}d`; small = `${hr}h`; }
  else if (d >= 1) big = `${d}d ${hr}h`;
  else if (hr >= 1) big = `${hr}h ${m}m`;
  else big = `${m}m`;
  return late ? [`-${big}`, "late"] : [big, small];
}

const fmtDue = t => new Date(t).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const isExam = it => it.kind === "exam" || it.kind === "quiz";
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';

function card(it, colors) {
  const ms = it.due - Date.now();
  const [big, small] = countdown(ms);
  const fill = ms < 0 ? 100 : Math.max(4, Math.min(100, 100 - (ms / (14 * D)) * 100));
  const share = gradeShare(it);
  const done = state.done.has(it.uid);

  return h("div", {
      class: "card" + (isExam(it) ? " exam" : "") + (done ? " done" : ""),
      style: { "--course": colors[it.course] || "#888", "--u": urgency(ms) },
    },
    h("div", { class: "card-top" },
      h("div", { class: "countdown" }, big, small ? h("small", {}, small) : null),
      h("button", {
        class: "check", title: done ? "Mark not done" : "Mark done", "aria-label": done ? "Mark not done" : "Mark done",
        onclick: () => {
          done ? state.done.delete(it.uid) : state.done.add(it.uid);
          store.set("done", [...state.done]);
          render();
        },
      }, svg(CHECK_SVG)),
    ),
    (isExam(it) || share != null) && h("div", { class: "tags" },
      isExam(it) && h("span", { class: "badge exam" }, it.kind === "exam" ? "★ Exam" : "Quiz"),
      share != null && h("span", { class: "badge pct" + (share >= 10 ? " big" : ""), title: "Share of your final grade" }, `${fmtPct(share)} of grade`),
    ),
    h("p", { class: "title" }, it.link ? h("a", { href: it.link, target: "_blank", rel: "noopener" }, it.title) : it.title),
    h("div", { class: "course" }, h("span", { class: "dot" }), shortCourse(it.course)),
    h("div", { class: "bar" }, h("i", { style: { width: fill + "%" } })),
    h("div", { class: "due" }, "Due " + fmtDue(it.due)),
  );
}

function sortItems(list) {
  if (state.sort === "impact") {
    return list.sort((a, b) => (gradeShare(b) ?? -1) - (gradeShare(a) ?? -1) || a.due - b.due);
  }
  return list.sort((a, b) => a.due - b.due);
}

function section(title, items, colors, cls = "") {
  return [
    h("div", { class: "section-title " + cls }, title),
    items.length
      ? h("div", { class: "grid" }, sortItems(items).map(it => card(it, colors)))
      : h("div", { class: "empty" }, "Nothing here 🎉"),
  ];
}

function renderFilters(colors) {
  const courses = [...new Set(state.items.map(i => i.course))].sort();
  $("#filters").replaceChildren(...courses.map(c =>
    h("button", {
      class: "chip" + (state.hidden.has(c) ? " off" : ""), style: { "--c": colors[c] }, title: c,
      onclick: () => {
        state.hidden.has(c) ? state.hidden.delete(c) : state.hidden.add(c);
        store.set("hidden", [...state.hidden]);
        render();
      },
    }, h("span", { class: "dot" }), shortCourse(c))
  ));
}

function render() {
  const connected = state.items.length > 0 || store.get("ics", null) != null;
  $("#setup").hidden = connected;
  $("#tracker").hidden = !connected;
  $("#stats").hidden = !connected;
  if (!connected) return;

  const colors = courseColors();
  renderFilters(colors);
  document.querySelectorAll(".seg button").forEach(b => b.classList.toggle("on", b.dataset.sort === state.sort));

  const t = Date.now();
  const visible = state.items.filter(it =>
    !state.hidden.has(it.course) && (state.showEvents || it.kind !== "event"));
  const active = visible.filter(it => !state.done.has(it.uid));
  const finished = visible.filter(it => state.done.has(it.uid) && t - it.due < 14 * D);

  const overdue = active.filter(it => it.due < t && t - it.due < 3 * D);
  const soon = active.filter(it => it.due >= t && it.due - t < 3 * D);
  const week = active.filter(it => it.due - t >= 3 * D && it.due - t < 7 * D);
  const later = active.filter(it => it.due - t >= 7 * D);

  $("#s-24").textContent = active.filter(it => it.due >= t && it.due - t < D).length;
  $("#s-week").textContent = active.filter(it => it.due >= t && it.due - t < 7 * D).length;
  $("#s-exam").textContent = active.filter(it => it.due >= t && isExam(it)).length;

  const board = [];
  if (overdue.length) board.push(...section("Overdue", overdue, colors, "over"));
  board.push(...section("Next 3 days", soon, colors));
  board.push(...section("This week", week, colors));
  board.push(...section("Later", later, colors));
  if (finished.length) {
    board.push(h("details", { class: "done-section" },
      h("summary", { class: "section-title" }, h("span", { class: "arrow" }, "▸"), ` Done (${finished.length})`),
      h("div", { class: "grid" }, finished.sort((a, b) => b.due - a.due).map(it => card(it, colors))),
    ));
  }
  $("#board").replaceChildren(...board);
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
  state.items = items;
  if (save) { store.set("ics", text); store.set("fetchedAt", Date.now()); }
  render();
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
  return ["BEGIN:VCALENDAR", "VERSION:2.0", ...ev.flatMap(([t, c, off], i) => [
    "BEGIN:VEVENT", `UID:event-assignment-demo${i}`, `DTSTART:${stamp(now + off)}`, `SUMMARY:${t} [${c}]`, "END:VEVENT",
  ]), "END:VCALENDAR"].join("\r\n");
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

document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
  state.sort = b.dataset.sort; store.set("sort", state.sort); render();
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
  Object.assign(state, { items: [], done: new Set(), hidden: new Set(), weights: {}, sort: "due", host: CFG.canvasHost, showEvents: false });
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

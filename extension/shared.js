// Shared helpers for finding and matching homework. Loaded by the service worker
// (importScripts), the offscreen parser, and content scripts, so no DOM use here.
(function (root) {
  "use strict";

  // Words that mark graded homework-like work, and words that mark things that aren't.
  const HW_WORDS = /\b(home\s*works?|hw|problem\s*sets?|p\s*sets?|assignments?|asgn|worksheets?|labs?|projects?|proj|programming\s+assignments?|written\s+assignments?|reading\s+responses?)(?![a-z])|\b(ps|pa|wa)\s*-?\s*\d/i;
  const NOT_HW = /\b(solutions?|sols?|soln|key|answers?|rubric|template|starter|slides?|lecture|notes|syllabus|grades?|instructions?\s+for\s+submission|example|sample|practice\s+exam|review\s+sheet)\b/i;

  // Canonical kinds so "HW1.pdf" matches "Homework 1" and "PS 3" matches "Problem Set 3".
  const KIND_PATTERNS = [
    [/\b(home\s*works?|hw)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "hw"],
    [/\b(problem\s*sets?|p\s*sets?|ps)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "ps"],
    [/\b(programming\s+assignments?|pa)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "pa"],
    [/\b(written\s+assignments?|wa)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "wa"],
    [/\b(assignments?|asgn)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "a"],
    [/\b(worksheets?)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "ws"],
    [/\b(labs?)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "lab"],
    [/\b(projects?|proj)\s*[-#:_]?\s*0*(\d{1,2})\b/i, "proj"],
  ];
  // Kinds that courses use interchangeably for "the weekly homework".
  const HOMEWORK_FAMILY = new Set(["hw", "ps", "a", "wa", "ws"]);

  function cleanTitle(title) {
    return String(title || "")
      .replace(/\.(pdf|docx?|ipynb|zip|tex|txt|md|html?)$/i, "")
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isHomeworkTitle(title) {
    const t = cleanTitle(title);
    return HW_WORDS.test(t) && !NOT_HW.test(t);
  }

  // { kind: "hw", num: 1, key: "hw1" } or null
  function homeworkKey(title) {
    const t = cleanTitle(title);
    for (const [re, kind] of KIND_PATTERNS) {
      const m = t.match(re);
      if (m) return { kind, num: +m[2], key: kind + m[2].replace(/^0+/, "") };
    }
    return null;
  }

  // "CSE020_FA26_001" / "CSE 20 - Fall 2026" / "MATH 20C" -> "CSE 20" / "MATH 20C"
  function shortCourse(name) {
    const m = String(name || "").match(/(?:^|[^A-Za-z])([A-Z]{2,5})[\s_-]*0*(\d{1,3}[A-Z]{0,3})(?![A-Za-z0-9])/);
    return m ? `${m[1]} ${m[2]}` : String(name || "").trim();
  }

  // Dates written into titles, e.g. "HW 3 (due 10/14)" or "due Oct 14". Returns ms or null.
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  function dateFromText(text, now = Date.now()) {
    const t = String(text || "");
    let mo, d, y;
    let m = t.match(/\bdue\b[^0-9a-z]{0,6}(?:on\s+)?(?:[a-z]{3,9},?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i);
    if (m) { mo = +m[1] - 1; d = +m[2]; y = m[3] ? +m[3] : null; }
    else {
      m = t.match(/\bdue\b[^0-9a-z]{0,6}(?:on\s+)?(?:[a-z]{3,9},?\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
      if (!m) return null;
      mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = m[3] ? +m[3] : null;
    }
    if (y != null && y < 100) y += 2000;
    if (y == null) {
      const n = new Date(now);
      y = n.getFullYear();
      // A date more than ~4 months back is probably next year (e.g. December -> January).
      if (new Date(y, mo, d).getTime() < now - 120 * 864e5) y++;
    }
    return new Date(y, mo, d, 23, 59).getTime();
  }

  // Gradescope "2026-10-05 23:59:00 -0700" -> ms
  function parseGsDatetime(s) {
    if (!s) return null;
    const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*([+-]\d{2}):?(\d{2})$/);
    if (m) {
      const t = Date.parse(`${m[1]}T${m[2].length === 5 ? m[2] + ":00" : m[2]}${m[3]}:${m[4]}`);
      return Number.isFinite(t) ? t : null;
    }
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  }

  // Gradescope text like "Oct 05 at 11:59PM" (no year)
  function parseGsText(s, now = Date.now()) {
    const m = String(s || "").match(/(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+(\d{1,2}):(\d{2})\s*([ap])m/i);
    if (!m) return null;
    let h = +m[4] % 12; if (m[6].toLowerCase() === "p") h += 12;
    let y = m[3] ? +m[3] : new Date(now).getFullYear();
    const mo = MONTHS[m[1].toLowerCase()];
    if (!m[3] && new Date(y, mo, +m[2]).getTime() < now - 200 * 864e5) y++;
    return new Date(y, mo, +m[2], h, +m[5]).getTime();
  }

  // ---------- Due-date estimates from posting dates ----------
  const DAY = 864e5;
  const median = xs => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
  const mode = xs => { const m = new Map(); let best = null, n = 0; for (const x of xs) { const c = (m.get(x) || 0) + 1; m.set(x, c); if (c > n) { n = c; best = x; } } return { value: best, count: n }; };
  const atTime = (ms, hm) => { const d = new Date(ms); const [h, mi] = hm.split(":").map(Number); d.setHours(h, mi, 0, 0); return d.getTime(); };
  const hmOf = ms => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const fmtDay = ms => new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  // The course's homework rhythm, learned from homework that has both a posting and due date.
  function courseRhythm(refs) {
    const pairs = refs.filter(r => r.due && r.posted && r.due > r.posted && r.due - r.posted < 28 * DAY);
    const dues = refs.filter(r => r.due).map(r => r.due);
    const midnight = ms => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const offset = median(pairs.map(r => Math.round((midnight(r.due) - midnight(r.posted)) / DAY)));  // calendar days
    const time = mode(dues.map(hmOf));
    const wd = mode(dues.map(t => new Date(t).getDay()));
    return {
      offsetDays: offset != null ? Math.min(14, Math.max(2, offset)) : 7,
      learned: offset != null,
      time: time.count >= 2 ? time.value : "23:59",
      weekday: dues.length >= 2 && wd.count / dues.length >= 0.75 ? wd.value : null,
      numbered: refs.filter(r => r.due && r.hw && HOMEWORK_FAMILY.has(r.hw.kind)),
    };
  }

  // Estimate due dates for undated homework in one course. Returns [{ ...item, due, estimated, basis }].
  function estimateCourse(undated, refs) {
    if (!undated.length) return [];
    const rh = courseRhythm(refs);
    const snap = ms => {
      if (rh.weekday == null) return ms;
      for (const delta of [0, 1, -1, 2, -2, 3, -3]) {
        const t = ms + delta * DAY;
        if (new Date(t).getDay() === rh.weekday) return t;
      }
      return ms;
    };
    const posted = undated.filter(u => u.posted).map(u => u.posted);
    // Many files posted within 2 days of each other = uploaded all at once; posting dates are useless.
    const bunched = posted.length >= 3 && Math.max(...posted) - Math.min(...posted) < 2 * DAY;
    const out = [];
    for (const u of undated) {
      const n = u.hw && HOMEWORK_FAMILY.has(u.hw.kind) ? u.hw.num : null;
      let due = null, basis = "";
      // 1. Same-numbered sequence anchored on a homework with a real due date (HW2 due Oct 9 -> HW3 ~Oct 16).
      const anchor = n != null && rh.numbered.length
        ? rh.numbered.reduce((best, r) => (!best || Math.abs(r.hw.num - n) < Math.abs(best.hw.num - n) ? r : best), null)
        : null;
      if (anchor && (bunched || !u.posted)) {
        due = anchor.due + (n - anchor.hw.num) * 7 * DAY;
        basis = `${anchor.title} is due ${fmtDay(anchor.due)}; assuming one per week`;
      } else if (u.posted && !bunched) {
        due = snap(atTime(u.posted + rh.offsetDays * DAY, rh.time));
        basis = `posted ${fmtDay(u.posted)}; ${rh.learned ? `this course's homework is usually due ${rh.offsetDays} days later` : "assuming due one week later"}`;
      } else if (bunched && n != null) {
        // 2. All uploaded at once, nothing to anchor on: space by number from the first homework.
        const first = Math.min(...posted);
        const nums = undated.filter(x => x.hw && HOMEWORK_FAMILY.has(x.hw.kind)).map(x => x.hw.num);
        const minN = Math.min(...nums);
        due = snap(atTime(first + rh.offsetDays * DAY + (n - minN) * 7 * DAY, rh.time));
        basis = "all homework was posted at once; assuming one due each week";
      }
      if (due) out.push({ ...u, due, estimated: true, basis });
    }
    return out;
  }

  // Merge Canvas module homework (often no date) with Gradescope assignments (dated) and
  // Canvas assignments that already have due dates (`known`).
  // Returns { items: dated or estimated items for the tracker, undated: still no date }.
  function mergeHomework(canvasHw, gsAssignments, known = []) {
    const items = [];
    const byCourse = (list) => {
      const m = new Map();
      for (const x of list) (m.get(x.course) || m.set(x.course, []).get(x.course)).push(x);
      return m;
    };
    const gsBy = byCourse(gsAssignments.map(g => ({ ...g, hw: g.hw || homeworkKey(g.title) })));
    const knownBy = byCourse(known.filter(k => k.due).map(k => ({ ...k, hw: k.hw || homeworkKey(k.title) })));
    const match = (list, c) => {
      const k = c.hw || homeworkKey(c.title);
      if (!k || !list) return null;
      let hit = list.find(g => g.hw && g.hw.key === k.key);
      if (!hit && HOMEWORK_FAMILY.has(k.kind)) {
        const cands = list.filter(g => g.hw && HOMEWORK_FAMILY.has(g.hw.kind) && g.hw.num === k.num);
        if (cands.length === 1) hit = cands[0];
      }
      return hit;
    };

    const pending = [];
    for (const c of canvasHw) {
      if (match(gsBy.get(c.course), c)) continue;      // Gradescope's copy has the date
      if (match(knownBy.get(c.course), c)) continue;   // already a dated Canvas assignment (in the feed)
      if (c.due) items.push({ ...c, source: "canvas-module" });
      else pending.push(c);
    }
    for (const g of gsAssignments) {
      if (!g.due) continue;
      items.push({
        uid: "gs-" + g.id, title: g.title, course: g.course, due: g.due, link: g.link,
        submitted: !!g.submitted, source: "gradescope",
      });
    }

    // Estimate the rest, course by course.
    const undated = [];
    for (const [course, list] of byCourse(pending)) {
      const refs = [
        ...(knownBy.get(course) || []).map(k => ({ title: k.title, due: k.due, posted: k.posted, hw: k.hw })),
        ...(gsBy.get(course) || []).filter(g => g.due).map(g => ({ title: g.title, due: g.due, posted: g.released || null, hw: g.hw })),
      ].filter(r => r.hw);   // learn only from numbered homework-like work, not exams
      const est = estimateCourse(list, refs);
      const got = new Set(est.map(e => e.uid));
      for (const e of est) items.push({ ...e, source: "canvas-module" });
      for (const u of list) if (!got.has(u.uid)) undated.push(u);
    }
    return { items, undated };
  }

  root.TTShared = { isHomeworkTitle, homeworkKey, cleanTitle, shortCourse, dateFromText, parseGsDatetime, parseGsText, mergeHomework, estimateCourse, courseRhythm };
})(typeof self !== "undefined" ? self : globalThis);

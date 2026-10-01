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

  // Merge Canvas module homework (often no date) with Gradescope assignments (dated).
  // Returns { items: dated items for the tracker, undated: homework with no date found }.
  function mergeHomework(canvasHw, gsAssignments) {
    const items = [];
    const usedGs = new Set();
    const byCourse = new Map();
    for (const g of gsAssignments) {
      const list = byCourse.get(g.course) || byCourse.set(g.course, []).get(g.course);
      list.push(g);
    }
    const findGs = (c) => {
      const list = byCourse.get(c.course) || [];
      const k = homeworkKey(c.title);
      if (!k) return null;
      let hit = list.find(g => g.hw && g.hw.key === k.key);
      if (!hit && HOMEWORK_FAMILY.has(k.kind)) {
        // Same number, both "homework family" (e.g. "PS 3.pdf" vs "Homework 3").
        const cands = list.filter(g => g.hw && HOMEWORK_FAMILY.has(g.hw.kind) && g.hw.num === k.num);
        if (cands.length === 1) hit = cands[0];
      }
      return hit || null;
    };

    const undated = [];
    for (const c of canvasHw) {
      const g = findGs(c);
      if (g) { usedGs.add(g.id); continue; }   // Gradescope's copy wins (it has the date)
      if (c.due) items.push({ ...c, source: "canvas-module" });
      else undated.push(c);
    }
    for (const g of gsAssignments) {
      if (!g.due) continue;
      items.push({
        uid: "gs-" + g.id, title: g.title, course: g.course, due: g.due, link: g.link,
        submitted: !!g.submitted, source: "gradescope",
      });
    }
    return { items, undated };
  }

  root.TTShared = { isHomeworkTitle, homeworkKey, cleanTitle, shortCourse, dateFromText, parseGsDatetime, parseGsText, mergeHomework };
})(typeof self !== "undefined" ? self : globalThis);

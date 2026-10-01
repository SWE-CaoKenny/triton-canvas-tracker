// Reads Gradescope pages (as DOM documents). Used by the offscreen parser for background
// sync and by the content script when you open a Gradescope course yourself.
// Gradescope has no public API, so this reads the student pages defensively: several
// selectors per field, falling back to visible text.
(function (root) {
  "use strict";
  const S = root.TTShared;
  const GS = "https://www.gradescope.com";
  const text = el => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  function currentTermLabel(now = new Date()) {
    const m = now.getMonth(), y = now.getFullYear();
    const season = m >= 8 ? "Fall" : m <= 2 ? "Winter" : m <= 5 ? "Spring" : "Summer";
    return { season, year: String(y) };
  }

  // Dashboard (gradescope.com/ when logged in) -> [{ id, name, short, term }]
  function parseDashboard(doc, now = new Date()) {
    if (isLoginPage(doc)) return { loggedIn: false, courses: [] };
    const courses = [];
    const seen = new Set();
    const anchors = [...doc.querySelectorAll('a[href^="/courses/"]')]
      .filter(a => /^\/courses\/\d+\/?$/.test(a.getAttribute("href")));
    for (const a of anchors) {
      const id = a.getAttribute("href").match(/\d+/)[0];
      if (seen.has(id)) continue;
      seen.add(id);
      // The term heading is the nearest preceding heading-like element in the course list.
      let term = "";
      const list = a.closest('[class*="courseList--coursesForTerm"], [class*="coursesForTerm"]');
      const head = list && list.previousElementSibling;
      if (head) term = text(head);
      const shortEl = a.querySelector('[class*="shortname"], h3, .courseBox--shortname');
      const nameEl = a.querySelector('[class*="courseBox--name"], [class*="name"]:not([class*="short"])');
      const name = text(shortEl) || text(a).split(" ").slice(0, 3).join(" ");
      courses.push({ id, name, title: text(nameEl), short: S.shortCourse(name), term });
    }
    // Keep only the current term when terms are labeled; otherwise keep everything.
    const { season, year } = currentTermLabel(now);
    const current = courses.filter(c => c.term && c.term.includes(season) && c.term.includes(year));
    const firstTerm = courses.find(c => c.term)?.term;
    const picked = current.length ? current : firstTerm ? courses.filter(c => c.term === firstTerm) : courses;
    return { loggedIn: true, courses: picked, allCount: courses.length };
  }

  function isLoginPage(doc) {
    return !!doc.querySelector('form[action*="/login"], input[name="session[password]"]') &&
      !doc.querySelector('a[href^="/courses/"]');
  }

  function pickDue(row, now) {
    const times = [...row.querySelectorAll("time[datetime]")];
    const byClass = times.find(t => /due/i.test(t.className) && !/late/i.test(t.className))
      || times.find(t => /due/i.test(t.getAttribute("aria-label") || "") && !/late/i.test(t.getAttribute("aria-label") || ""));
    const chosen = byClass || (times.length >= 2 ? times[1] : times[0]);
    if (chosen) {
      const ms = S.parseGsDatetime(chosen.getAttribute("datetime"));
      if (ms) return ms;
    }
    // Fallback: visible text like "Due Date: Oct 05 at 11:59PM"
    const t = text(row);
    const dueIdx = t.search(/\bdue\b/i);
    return S.parseGsText(dueIdx >= 0 ? t.slice(dueIdx) : t, now.getTime ? now.getTime() : now);
  }

  function pickReleased(row) {
    const times = [...row.querySelectorAll("time[datetime]")];
    const el = times.find(t => /release/i.test(t.className) || /release/i.test(t.getAttribute("aria-label") || ""))
      || (times.length >= 2 ? times[0] : null);
    return el ? S.parseGsDatetime(el.getAttribute("datetime")) : null;
  }

  // Course page (gradescope.com/courses/123) -> { course, assignments: [...] }
  function parseCourse(doc, courseId, fallbackShort, now = new Date()) {
    if (isLoginPage(doc)) return { loggedIn: false, assignments: [] };
    const header = text(doc.querySelector('[class*="courseHeader--title"], .courseHeader h1, h1'));
    const course = S.shortCourse(fallbackShort || header) || fallbackShort || header;
    const table = doc.querySelector("#assignments-student-table") ||
      [...doc.querySelectorAll("table")].find(tb => /due|status|name/i.test(text(tb.querySelector("thead"))));
    const assignments = [];
    if (table) {
      for (const row of table.querySelectorAll("tbody tr")) {
        const nameCell = row.querySelector("th") || row.querySelector("td");
        const nameEl = nameCell && (nameCell.querySelector("a, button") || nameCell);
        const title = text(nameEl);
        if (!title) continue;
        const a = nameCell.querySelector("a[href]");
        const href = a ? a.getAttribute("href") : "";
        const idMatch = href.match(/assignments\/(\d+)/) ||
          String(nameEl.getAttribute && (nameEl.getAttribute("data-assignment-id") || "")).match(/(\d+)/);
        const id = idMatch ? idMatch[1] : `${courseId}-${title.toLowerCase().replace(/\W+/g, "-")}`;
        const status = text(row.querySelector('[class*="submissionStatus"], td:nth-of-type(1)')) || text(row);
        const submitted = !/no submission/i.test(status) && /(submitted|graded|\d+(\.\d+)?\s*\/\s*\d+(\.\d+)?)/i.test(status);
        assignments.push({
          id: String(id),
          title,
          course,
          due: pickDue(row, now),
          released: pickReleased(row),
          link: href ? new URL(href, GS).href : `${GS}/courses/${courseId}`,
          submitted,
          hw: S.homeworkKey(title),
        });
      }
    }
    return { loggedIn: true, course, header, assignments, foundTable: !!table };
  }

  root.TTGradescope = { parseDashboard, parseCourse, isLoginPage };
})(typeof self !== "undefined" ? self : globalThis);

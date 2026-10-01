// Scans Canvas (documented REST API) for homework the calendar feed misses.
// Environment-agnostic: the extension calls it with cookie-authenticated fetches, the
// website's server calls it with a user's access token. Callers provide `getJson(url)`
// returning { data, next } and the Canvas base URL.
(function (root) {
  "use strict";
  const S = root.TTShared;
  const SKIP_TYPES = new Set(["Discussion", "Quiz"]);   // already in the calendar feed
  const MAX_DETAIL_FETCHES = 60;                        // posting-date lookups per scan

  async function getAll(getJson, url, maxPages = 10) {
    const out = [];
    for (let i = 0; url && i < maxPages; i++) {
      const { data, next } = await getJson(url);
      if (Array.isArray(data)) out.push(...data); else break;
      url = next;
    }
    return out;
  }

  const ts = v => { const t = Date.parse(v || ""); return Number.isFinite(t) ? t : null; };

  // Run `fn` over `list` with limited concurrency.
  async function pool(list, n, fn) {
    const out = new Array(list.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
      while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
    }));
    return out;
  }

  async function scan({ base, getJson, now = Date.now(), isLoginError = () => false }) {
    const sameHost = u => { try { return new URL(u).origin === new URL(base).origin; } catch { return false; } };
    const courses = (await getAll(getJson, `${base}/api/v1/users/self/courses?enrollment_state=active&include[]=term&per_page=100`))
      .filter(c => c && !c.access_restricted_by_date && c.name)
      .filter(c => !c.term || !c.term.end_at || ts(c.term.end_at) > now - 14 * 864e5);

    let detailBudget = MAX_DETAIL_FETCHES;
    const perCourse = await pool(courses, 3, async c => {
      const course = S.shortCourse(c.course_code || c.name);
      const hw = [], known = [];

      // Assignments with due dates: used to skip duplicates and to learn the course's rhythm.
      try {
        const asg = await getAll(getJson, `${base}/api/v1/courses/${c.id}/assignments?per_page=100&order_by=due_at`, 4);
        for (const a of asg) {
          if (!a || !a.name) continue;
          known.push({
            course, title: a.name, due: ts(a.due_at), posted: ts(a.unlock_at) || ts(a.created_at),
            hw: S.homeworkKey(a.name), source: "canvas-assignment",
          });
        }
      } catch (e) { if (isLoginError(e)) throw e; }

      let modules = [];
      try {
        modules = await getAll(getJson, `${base}/api/v1/courses/${c.id}/modules?include[]=items&include[]=content_details&per_page=50`, 5);
      } catch (e) { if (isLoginError(e)) throw e; return { hw, known }; }

      const seenKeys = new Set();
      for (const mod of modules) {
        let items = mod.items;
        if (!items && mod.items_url && sameHost(mod.items_url)) {
          try { items = await getAll(getJson, `${mod.items_url}${mod.items_url.includes("?") ? "&" : "?"}include[]=content_details&per_page=100`, 3); }
          catch (e) { if (isLoginError(e)) throw e; items = []; }
        }
        for (const it of items || []) {
          if (SKIP_TYPES.has(it.type)) continue;
          if (it.type === "Assignment" && it.content_details && it.content_details.due_at) continue;
          const title = S.cleanTitle(it.title);
          if (!S.isHomeworkTitle(title)) continue;
          const k = S.homeworkKey(title);
          if (k) { if (seenKeys.has(k.key)) continue; seenKeys.add(k.key); }

          // When was it posted? File/page details first, then module unlock date.
          let posted = ts(it.content_details && it.content_details.unlock_at) || ts(mod.unlock_at);
          let postedFrom = posted ? "unlock date" : null;
          if (!posted && detailBudget > 0 && it.url && sameHost(it.url) && (it.type === "File" || it.type === "Page")) {
            detailBudget--;
            try {
              const { data } = await getJson(it.url);
              posted = ts(data.unlock_at) || ts(data.publish_at) || ts(data.created_at);
              postedFrom = data.unlock_at ? "unlock date" : "upload date";
            } catch (e) { if (isLoginError(e)) throw e; }
          }
          hw.push({
            uid: `cm-${c.id}-${it.id}`,
            title, course,
            due: S.dateFromText(`${it.title} ${mod.name}`) || null,
            posted, postedFrom,
            link: it.html_url || `${base}/courses/${c.id}/modules`,
            module: mod.name,
            hw: k,
          });
        }
      }
      return { hw, known };
    });

    return {
      hw: perCourse.flatMap(r => r.hw),
      known: perCourse.flatMap(r => r.known),
      courseCount: courses.length,
    };
  }

  root.TTCanvasScan = { scan };
})(typeof self !== "undefined" ? self : globalThis);

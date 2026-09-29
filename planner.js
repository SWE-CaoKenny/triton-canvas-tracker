// Reads a UCSD Class Planner share page (classplanner.apps.ucsd.edu/view/CS2…) and returns
// a compact schedule: class meetings, exams, building locations and walking times.
//
// The share page is a Next.js app whose server-rendered payload contains a `schedule`
// object. We pull that object out rather than scraping visible HTML. If Class Planner
// changes its page, this file is the only thing that needs updating.

const PLANNER_HOST = "classplanner.apps.ucsd.edu";
const PLANNER_PATH = /^\/view\/CS2[A-Za-z0-9_-]{8,4000}$/;

function validatePlannerUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== PLANNER_HOST) return null;
  if (u.username || u.password || (u.port && u.port !== "443")) return null;
  if (!PLANNER_PATH.test(u.pathname)) return null;
  u.search = ""; u.hash = "";
  return u;
}

const parseError = msg => Object.assign(new Error(msg), { code: "PARSE" });

// Concatenate the React Server Components payload chunks embedded in the page.
function rscPayload(html) {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let out = "", m;
  while ((m = re.exec(html))) {
    try { out += JSON.parse(`"${m[1]}"`); } catch { /* skip malformed chunk */ }
  }
  return out;
}

// Return the JSON value that starts at `start` (a "{"), respecting strings and escapes.
function jsonAt(text, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw parseError("unterminated schedule object");
}

function findSchedule(payload) {
  const marker = '"schedule":{"term_code"';
  const i = payload.indexOf(marker);
  if (i < 0) throw parseError("schedule object not found");
  return jsonAt(payload, i + '"schedule":'.length);
}

// "CSE 020" / "MATH-020C" -> "CSE 20" / "MATH 20C"
function courseName(s) {
  const m = String(s || "").match(/([A-Z]{2,5})[\s-]*0*(\d{1,3}[A-Z]{0,3})/);
  return m ? `${m[1]} ${m[2]}` : String(s || "").trim();
}

function toMinutes(t) {
  const m = String(t || "").trim().match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i);
  if (!m) return null;
  let h = +m[1] % 12;
  if (m[3].toLowerCase() === "p") h += 12;
  return h * 60 + +m[2];
}

const TYPE_LABELS = { lecture: "LEC", discussion: "DIS", laboratory: "LAB", seminar: "SEM", studio: "STU", tutorial: "TUT" };

function parseSchedulePage(html) {
  const s = findSchedule(rscPayload(html));
  const events = Array.isArray(s.timed_events) ? s.timed_events : [];

  // Group meetings by section so each section appears once in the details table.
  const sections = new Map();
  const meetings = [];
  for (const ev of events) {
    const sec = ev.section || {}, mt = ev.meeting || {};
    const course = courseName(sec.class_name || ev.title);
    const type = ev.type_label || TYPE_LABELS[String(sec.instruction_type_name || "").toLowerCase()] || "";
    const meeting = {
      sectionId: sec.section_id || "",
      course,
      type,
      day: mt.day_code || "",
      start: Number.isFinite(mt.start_minutes) ? mt.start_minutes : toMinutes(mt.start_time_display),
      end: Number.isFinite(mt.end_minutes) ? mt.end_minutes : toMinutes(mt.end_time_display),
      buildingCode: mt.building_code || "",
      building: mt.building_name || "",
      room: mt.room_code || ev.location_label || "",
      remote: !!mt.is_remote,
      tba: !!mt.is_tba,
      instructor: sec.instructors_text || "",
    };
    if (meeting.day && meeting.start != null && meeting.end != null) meetings.push(meeting);

    if (!sections.has(meeting.sectionId)) {
      sections.set(meeting.sectionId, {
        id: meeting.sectionId,
        course,
        title: sec.course_title || sec.moduleName || "",
        type,
        code: sec.section_code || "",
        instructor: meeting.instructor,
        units: sec.units_display || "",
        meetings: [],
      });
    }
    sections.get(meeting.sectionId).meetings.push({
      day: meeting.day, start: meeting.start, end: meeting.end,
      building: meeting.building, buildingCode: meeting.buildingCode, room: meeting.room,
      remote: meeting.remote, tba: meeting.tba,
    });
  }

  const exams = (Array.isArray(s.supplemental) ? s.supplemental : [])
    .filter(x => x && x.raw_date)
    .map(x => {
      const [a, b] = String(x.time || "").split("-");
      return {
        kind: x.kind || "Exam",
        course: courseName(x.title),
        date: x.raw_date,               // YYYY-MM-DD
        start: toMinutes(a), end: toMinutes(b),
        time: x.time || "",
        location: x.location || "",
      };
    });

  const md = s.map_data || {};
  const locations = (Array.isArray(md.locations) ? md.locations : [])
    .filter(l => Number.isFinite(l.latitude) && Number.isFinite(l.longitude))
    .map(l => ({
      code: l.building_code || l.key, name: l.display_name || l.building_code,
      lat: l.latitude, lng: l.longitude, address: l.address || "",
    }));

  const walks = [];
  for (const day of Array.isArray(md.days) ? md.days : []) {
    const bySeq = new Map((day.stops || []).map(st => [st.sequence, st]));
    for (const t of day.transitions || []) {
      const from = bySeq.get(t.from_sequence), to = bySeq.get(t.to_sequence);
      if (!from || !to) continue;
      walks.push({
        day: day.day_code,
        from: { course: courseName(from.title), type: from.type_label, loc: t.from_location_key, end: from.end_minutes },
        to: { course: courseName(to.title), type: to.type_label, loc: t.to_location_key, start: to.start_minutes },
        walkMinutes: t.estimated_minutes, gapMinutes: t.gap_minutes, meters: t.distance_meters,
        status: t.status || (t.available ? "available" : "unknown"),
      });
    }
  }

  return {
    source: "ucsd-class-planner",
    term: s.term_label || s.term_code || "",
    termCode: s.term_code || "",
    finalsStart: s.finals_start_date || null,
    finalsEnd: s.finals_end_date || null,
    shareUrl: `https://${PLANNER_HOST}/view/${s.schedule_ref || ""}`,
    sections: [...sections.values()],
    meetings,
    exams,
    locations,
    walks,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { validatePlannerUrl, parseSchedulePage, courseName, toMinutes };

// Run: node extension/test/shared.test.js
require("../shared.js");
const S = globalThis.TTShared;
const assert = require("node:assert/strict");
let n = 0; const t = (name, fn) => { fn(); n++; };

t("homework titles", () => {
  for (const yes of ["HW1.pdf", "hw_2.pdf", "Homework 3", "Problem Set 4.pdf", "PS5.pdf", "pset 6", "Assignment 2", "PA1", "Lab 3 instructions", "Worksheet 7", "Project 1 spec.pdf", "Written Assignment 2"])
    assert.ok(S.isHomeworkTitle(yes), yes);
  for (const no of ["HW1 Solutions.pdf", "hw2_sol.pdf", "Lecture 3 slides.pdf", "Syllabus.pdf", "Week 1 notes", "Answer key HW3", "Practice exam", "Discussion 1"])
    assert.ok(!S.isHomeworkTitle(no), no);
});

t("homework keys match across naming styles", () => {
  const k = x => S.homeworkKey(x)?.key;
  assert.equal(k("HW1.pdf"), "hw1");
  assert.equal(k("Homework 1"), "hw1");
  assert.equal(k("hw_01.pdf"), "hw1");
  assert.equal(k("Problem Set 3"), "ps3");
  assert.equal(k("PS3.pdf"), "ps3");
  assert.equal(k("Programming Assignment 2"), "pa2");
  assert.equal(k("Lab 4"), "lab4");
  assert.equal(S.homeworkKey("Syllabus"), null);
});

t("short course names", () => {
  assert.equal(S.shortCourse("CSE020_FA26_001"), "CSE 20");
  assert.equal(S.shortCourse("MATH 20C - Fall 2026"), "MATH 20C");
  assert.equal(S.shortCourse("PSYC 3"), "PSYC 3");
});

t("dates in titles", () => {
  const now = new Date(2026, 9, 1).getTime();
  const d = ms => new Date(ms).toDateString();
  assert.equal(d(S.dateFromText("HW 3 (due 10/14)", now)), new Date(2026, 9, 14).toDateString());
  assert.equal(d(S.dateFromText("Homework 4 - due Oct 21", now)), new Date(2026, 9, 21).toDateString());
  assert.equal(d(S.dateFromText("PS2 due Friday, Jan 8", new Date(2026, 11, 1).getTime())), new Date(2027, 0, 8).toDateString());
  assert.equal(S.dateFromText("HW1.pdf", now), null);
});

t("gradescope dates", () => {
  assert.equal(new Date(S.parseGsDatetime("2026-10-05 23:59:00 -0700")).toISOString(), "2026-10-06T06:59:00.000Z");
  const ms = S.parseGsText("Due Date: Oct 05 at 11:59PM", new Date(2026, 8, 30).getTime());
  assert.equal(new Date(ms).getHours(), 23); assert.equal(new Date(ms).getDate(), 5);
});

t("merge: Gradescope date wins, no duplicates, undated kept", () => {
  const canvas = [
    { uid: "cm-1", title: "HW1", course: "MATH 20C", due: null },
    { uid: "cm-2", title: "HW2", course: "MATH 20C", due: null },
    { uid: "cm-3", title: "PS3", course: "MATH 20C", due: null },           // gs calls it Homework 3
    { uid: "cm-4", title: "Worksheet 9", course: "PHIL 27", due: null },     // nowhere on gs
    { uid: "cm-5", title: "Lab 2", course: "CSE 20", due: Date.UTC(2026, 9, 9) }, // date from title
  ];
  const gs = [
    { id: "11", title: "Homework 1", course: "MATH 20C", due: 1, hw: S.homeworkKey("Homework 1"), submitted: true },
    { id: "12", title: "Homework 2", course: "MATH 20C", due: 2, hw: S.homeworkKey("Homework 2") },
    { id: "13", title: "Homework 3", course: "MATH 20C", due: 3, hw: S.homeworkKey("Homework 3") },
    { id: "14", title: "Midterm 1", course: "MATH 20C", due: 4, hw: null },
  ];
  const { items, undated } = S.mergeHomework(canvas, gs);
  assert.deepEqual(items.map(i => i.title).sort(), ["Homework 1", "Homework 2", "Homework 3", "Lab 2", "Midterm 1"]);
  assert.equal(items.find(i => i.title === "Homework 1").submitted, true);
  assert.deepEqual(undated.map(u => u.title), ["Worksheet 9"]);
});

console.log(`shared.js: ${n} test groups passed`);

// ---------- estimates ----------
const at = (y, m, d, h = 23, mi = 59) => new Date(y, m - 1, d, h, mi).getTime();
const day = ms => new Date(ms).toDateString() + " " + new Date(ms).toTimeString().slice(0, 5);
const hw = (n, posted, course = "MATH 20C") => ({ uid: `cm-${course}-${n}`, title: `HW${n}`, course, due: null, posted, hw: S.homeworkKey(`HW${n}`) });

t("estimate: learns the course's rhythm", () => {
  const known = [
    { course: "MATH 20C", title: "Homework 1", posted: at(2026, 9, 30, 9, 0), due: at(2026, 10, 7, 22, 0) },
    { course: "MATH 20C", title: "Homework 2", posted: at(2026, 10, 7, 9, 0), due: at(2026, 10, 14, 22, 0) },
  ];
  const { items } = S.mergeHomework([hw(3, at(2026, 10, 14, 9, 0))], [], known);
  assert.equal(items.length, 1);
  assert.equal(items[0].estimated, true);
  assert.equal(day(items[0].due), day(at(2026, 10, 21, 22, 0)));   // 7 days later, at the course's usual 10pm
  assert.match(items[0].basis, /usually due 7 days later/);
});

t("estimate: default one week at 11:59pm", () => {
  const { items } = S.mergeHomework([hw(1, at(2026, 10, 1, 12, 0), "PHIL 27")], [], []);
  assert.equal(day(items[0].due), day(at(2026, 10, 8)));
});

t("estimate: snaps to the usual weekday", () => {
  const known = [1, 2, 3].map(i => ({ course: "CSE 20", title: `Homework ${i}`, due: at(2026, 10, 2 + 7 * (i - 1)) })); // Fridays
  const { items } = S.mergeHomework([hw(4, at(2026, 10, 19, 10, 0), "CSE 20")], [], known);           // posted Monday
  assert.equal(new Date(items[0].due).getDay(), 5);
});

t("estimate: all uploaded at once, anchored on a Gradescope date", () => {
  const up = at(2026, 9, 25, 10, 0);
  const canvas = [1, 2, 3, 4].map(n => hw(n, up + n * 60e3));
  const gs = [{ id: "2", title: "Homework 2", course: "MATH 20C", due: at(2026, 10, 9), hw: S.homeworkKey("Homework 2") }];
  const { items } = S.mergeHomework(canvas, gs, []);
  const byTitle = Object.fromEntries(items.map(i => [i.title, i]));
  assert.equal(byTitle["Homework 2"].estimated, undefined);             // real date from Gradescope
  assert.equal(day(byTitle.HW3.due), day(at(2026, 10, 16)));
  assert.equal(day(byTitle.HW4.due), day(at(2026, 10, 23)));
  assert.equal(day(byTitle.HW1.due), day(at(2026, 10, 2)));
});

t("estimate: all uploaded at once, nothing to anchor on", () => {
  const up = at(2026, 9, 25, 10, 0);
  const { items } = S.mergeHomework([1, 2, 3].map(n => hw(n, up)), [], []);
  assert.deepEqual(items.map(i => day(i.due)), [at(2026, 10, 2), at(2026, 10, 9), at(2026, 10, 16)].map(day));
  assert.match(items[0].basis, /posted at once/);
});

t("skips module PDFs that are already dated Canvas assignments", () => {
  const known = [{ course: "MATH 20C", title: "Homework 5", due: at(2026, 10, 30), posted: at(2026, 10, 23) }];
  const { items, undated } = S.mergeHomework([hw(5, at(2026, 10, 23))], [], known);
  assert.equal(items.length + undated.length, 0);
});

t("exams don't skew the rhythm", () => {
  const known = [{ course: "PSYC 3", title: "Midterm", posted: at(2026, 9, 25), due: at(2026, 10, 28) }];
  const { items } = S.mergeHomework([hw(1, at(2026, 10, 1, 12, 0), "PSYC 3")], [], known);
  assert.equal(day(items[0].due), day(at(2026, 10, 8)));
});

console.log(`estimates: all passed (${n} groups total)`);

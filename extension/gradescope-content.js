// Passive capture: when you open a Gradescope course page yourself, read the assignment
// table that's already on screen and hand it to the extension. Makes no requests.
(() => {
  const m = location.pathname.match(/^\/courses\/(\d+)\/?$/);
  if (!m) return;
  const result = TTGradescope.parseCourse(document, m[1], null);
  if (!result.loggedIn || !result.assignments.length) return;
  chrome.runtime.sendMessage({ type: "gsCourseCaptured", courseId: m[1], result }).catch(() => {});
})();

// Service workers can't parse HTML, so Gradescope pages are parsed here.
// Scripts in the parsed document never run (DOMParser documents are inert).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target !== "offscreen") return false;
  const doc = new DOMParser().parseFromString(msg.html, "text/html");
  if (msg.kind === "dashboard") reply(TTGradescope.parseDashboard(doc));
  else if (msg.kind === "course") reply(TTGradescope.parseCourse(doc, msg.courseId, msg.short));
  else reply(null);
  return false;
});

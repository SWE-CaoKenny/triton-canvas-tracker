const TRACKER = "https://triton-canvas-tracker-production.up.railway.app/";
const $ = id => document.getElementById(id);

const LABEL = { ok: ["Connected", "ok"], login: ["Log in needed", "login"], error: ["Couldn't read", "error"] };

function show(el, state) {
  const [t, cls] = LABEL[state] || ["Not checked yet", "muted"];
  el.textContent = t; el.className = cls;
}

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: "getState" });
  const st = s.status || {};
  show($("canvas"), st.canvas);
  show($("gs"), st.gradescope);
  const d = s.syncData || {};
  $("count").textContent = `${(d.items || []).length} dated · ${(d.undated || []).length} no date`;
  $("last").textContent = st.lastSync ? `Last checked ${new Date(st.lastSync).toLocaleString()}` : "";
  $("bg").checked = !s.settings || s.settings.background !== false;
  const hints = [];
  if (st.canvas === "login") hints.push(`<a href="https://canvas.ucsd.edu/" target="_blank">Log in to Canvas</a>, then Sync now.`);
  if (st.gradescope === "login") hints.push(`<a href="https://www.gradescope.com/" target="_blank">Log in to Gradescope</a>, then Sync now.`);
  $("hints").innerHTML = hints.map(h => `<div class="hint">${h}</div>`).join("");
}

$("sync").onclick = async () => {
  $("sync").disabled = true; $("sync").textContent = "Syncing…";
  await chrome.runtime.sendMessage({ type: "syncNow", force: true });
  $("sync").disabled = false; $("sync").textContent = "Sync now";
  refresh();
};
$("open").onclick = () => chrome.tabs.create({ url: TRACKER });
$("bg").onchange = e => chrome.runtime.sendMessage({ type: "setBackground", value: e.target.checked });

// Summary for troubleshooting the Gradescope/Canvas readers. Copy it only if you choose to share it.
$("diag").onclick = async () => {
  const s = await chrome.runtime.sendMessage({ type: "getState" });
  const gs = s.gsCourses || {};
  const diag = {
    version: chrome.runtime.getManifest().version,
    status: s.status,
    gradescope: Object.entries(gs).map(([id, c]) => ({
      id, course: c.course, foundTable: c.foundTable, passive: !!c.passive, count: (c.assignments || []).length,
      withDue: (c.assignments || []).filter(a => a.due).length,
      sample: (c.assignments || []).slice(0, 3).map(a => ({ title: a.title, due: a.due && new Date(a.due).toISOString(), submitted: a.submitted, hw: a.hw && a.hw.key })),
    })),
    canvas: (s.canvasHw || []).slice(0, 15).map(h => ({ course: h.course, title: h.title, due: !!h.due, module: h.module })),
  };
  await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
  $("diagMsg").textContent = "Copied. Paste it to whoever is helping you debug.";
};

refresh();

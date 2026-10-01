// Triton Sync bookmarklet: runs on a Canvas page you already have open, scans your course
// modules with your existing Canvas login (read-only), then gives you a button that opens
// Triton Tracker with the results in the URL fragment (#...), which never reaches a server.
// Wrapped by /bookmarklet.js together with shared.js and canvas-scan.js.
(async () => {
  const TRACKER = "__TT_ORIGIN__/";
  const ID = "tt-sync-panel";
  document.getElementById(ID)?.remove();

  const panel = document.createElement("div");
  panel.id = ID;
  panel.setAttribute("role", "dialog");
  panel.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;background:#fff;color:#1f2a37;" +
    "border:1px solid #c9d2db;border-radius:6px;box-shadow:0 10px 40px rgba(24,43,73,.3);font:14px/1.45 -apple-system,Roboto,Arial,sans-serif;overflow:hidden";
  panel.innerHTML =
    '<div style="background:#182B49;color:#fff;padding:9px 12px;border-bottom:3px solid #FFCD00;display:flex;justify-content:space-between;align-items:center;font-weight:700">' +
    '<span>Triton Sync</span><button data-x style="background:none;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer" aria-label="Close">×</button></div>' +
    '<div data-body style="padding:12px"></div>';
  document.body.appendChild(panel);
  panel.querySelector("[data-x]").onclick = () => panel.remove();
  const body = panel.querySelector("[data-body]");
  const say = html => { body.innerHTML = html; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  if (!window.ENV) {   // every Canvas page defines a global ENV object
    say("Open any <b>Canvas</b> page (like your Dashboard), then click the Triton Sync bookmark again.");
    return;
  }

  say("Scanning your Canvas modules for homework… <span data-n></span><div style='color:#5b6770;font-size:12px;margin-top:6px'>Read-only. This can take up to a minute.</div>");
  let calls = 0;
  const getJson = async url => {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) throw new Error("off-host");
    const n = body.querySelector("[data-n]"); if (n) n.textContent = `(${++calls})`;
    const res = await fetch(u.href, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (res.status === 401) throw Object.assign(new Error("login"), { login: true });
    if (!res.ok) throw Object.assign(new Error(`Canvas ${res.status}`), { status: res.status });
    const data = JSON.parse((await res.text()).replace(/^while\(1\);/, ""));
    const m = (res.headers.get("Link") || "").match(/<([^>]+)>;\s*rel="next"/);
    return { data, next: m ? m[1] : null };
  };

  try {
    const r = await self.TTCanvasScan.scan({ base: location.origin, getJson, isLoginError: e => !!e.login });
    const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] != null).map(k => [k, typeof o[k] === "string" ? o[k].slice(0, 300) : o[k]]));
    const payload = {
      v: 1, at: Date.now(), host: location.host, courses: r.courseCount,
      hw: r.hw.slice(0, 400).map(h => pick(h, ["uid", "title", "course", "due", "posted", "postedFrom", "link", "module"])),
      known: r.known.filter(k => k.due && k.hw).slice(0, 400).map(k => pick(k, ["course", "title", "due", "posted"])),
    };
    const json = JSON.stringify(payload);
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const href = `${TRACKER}#tt-import=${b64}`;
    const n = payload.hw.length;
    say(`Found <b>${n}</b> homework item${n === 1 ? "" : "s"} in modules across ${r.courseCount} course${r.courseCount === 1 ? "" : "s"}.` +
      (n ? `<ul style="margin:8px 0;padding-left:18px;max-height:140px;overflow:auto;font-size:12px">${payload.hw.slice(0, 12).map(h => `<li>${esc(h.course)}: ${esc(h.title)}</li>`).join("")}${n > 12 ? `<li>…and ${n - 12} more</li>` : ""}</ul>` : "") +
      `<a data-go href="${esc(href)}" target="_blank" rel="noopener" style="display:block;text-align:center;background:#00629B;color:#fff;text-decoration:none;font-weight:600;padding:8px;border-radius:4px;margin-top:8px">Send to Triton Tracker</a>`);
    body.querySelector("[data-go]").addEventListener("click", () => setTimeout(() => panel.remove(), 300));
  } catch (e) {
    say(e.login
      ? "Canvas says you're not logged in. Log in to Canvas, then click the bookmark again."
      : `Something went wrong while reading Canvas (${esc(e.message || e)}). Try again in a minute.`);
  }
})();

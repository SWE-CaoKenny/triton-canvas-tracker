// Runs on the Triton Tracker site and hands it the synced homework.
// Only talks to the page it's running on (same origin), never to other sites.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const post = (type, data) => window.postMessage({ source: "tt-extension", type, data, version: VERSION }, location.origin);

  const sendData = () => chrome.storage.local.get("syncData").then(({ syncData }) => post("sync", syncData || null));

  window.addEventListener("message", e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const msg = e.data;
    if (!msg || msg.source !== "tt-page") return;
    if (msg.type === "ready") { post("hello"); sendData(); }
    if (msg.type === "syncNow") {
      post("syncing");
      chrome.runtime.sendMessage({ type: "syncNow", force: true }).then(sendData, sendData);
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.syncData) post("sync", changes.syncData.newValue || null);
  });

  post("hello");
  sendData();
})();

// Cloudflare build step (wrangler.toml [build]). server.js builds these two files on the
// fly; on Cloudflare they are plain static assets, generated into ./public.
const fs = require("node:fs");
const path = require("node:path");

const read = f => fs.readFileSync(path.join(__dirname, f), "utf8");
const out = f => path.join(__dirname, "public", f);

fs.mkdirSync(out("lib"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "extension/shared.js"), out("lib/shared.js"));

const parts = ["extension/shared.js", "extension/canvas-scan.js", "public/bookmarklet-main.js"].map(read);
fs.writeFileSync(out("bookmarklet.js"), `(()=>{const self={};\n${parts.join("\n;\n")}\n})();`);

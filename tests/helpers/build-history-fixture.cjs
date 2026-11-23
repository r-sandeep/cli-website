#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const dist = path.join(root, "dist");
const fixtureSource = path.join(__dirname, "history-browser-fixture.js");

if (!fs.existsSync(dist)) {
  throw new Error("dist is missing; run npm run build before creating the history fixture");
}

const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Command history storage checks</title></head>
<body>
  <button id="run-store" type="button">Run storage checks</button>
  <div id="store-results" aria-live="polite"></div>
  <script src="/__asd_history/history.js"></script>
  <script src="/__asd_history/history-browser-fixture.js"></script>
</body>
</html>
`;

const fixtureDir = path.join(dist, "__asd_history");
fs.mkdirSync(fixtureDir, { recursive: true });
fs.copyFileSync(path.join(root, "js", "history.js"), path.join(fixtureDir, "history.js"));
fs.copyFileSync(fixtureSource, path.join(fixtureDir, "history-browser-fixture.js"));
fs.writeFileSync(path.join(dist, "__asd_history.html"), html);

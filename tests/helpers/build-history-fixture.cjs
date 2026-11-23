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
<head>
  <meta charset="utf-8">
  <title>Command history storage checks</title>
  <link rel="stylesheet" href="/__asd_history/xterm.css">
  <style>#actual-terminal { width: 960px; height: 420px; }</style>
</head>
<body>
  <div id="actual-terminal" aria-label="Actual xterm reset fixture"></div>
  <button id="run-store" type="button">Run storage checks</button>
  <div id="store-results" aria-live="polite"></div>
  <button id="run-terminal" type="button">Run terminal checks</button>
  <div id="terminal-results" aria-live="polite"></div>
  <button id="run-execution-timing" type="button" disabled>Run execution timing checks</button>
  <div id="execution-timing-results" aria-live="polite"></div>
  <button id="run-pending-resize" type="button">Run pending resize checks</button>
  <div id="pending-resize-results" aria-live="polite"></div>
  <button id="run-lifecycle-repair" type="button">Run lifecycle repair checks</button>
  <div id="lifecycle-repair-results" aria-live="polite"></div>
  <div id="submission-scope-status" aria-live="polite">LOADING</div>
  <button id="run-submission-scope" type="button" disabled>Run submission scope checks</button>
  <div id="submission-scope-results" aria-live="polite"></div>
  <button id="run-ordered-input" type="button">Run ordered input checks</button>
  <div id="ordered-input-results" aria-live="polite">ORDERED INPUT READY</div>
  <button id="run-write-exceptions" type="button">Run write exception checks</button>
  <div id="write-exception-results" aria-live="polite"></div>
  <script src="/__asd_history/xterm.js"></script>
  <script src="/__asd_history/history.js"></script>
  <script src="/__asd_history/pipeline.js"></script>
  <script src="/__asd_history/terminal-ext.js"></script>
  <script src="/__asd_history/terminal.js"></script>
  <script src="/__asd_history/ascii-art.js"></script>
  <script src="/__asd_history/help.js"></script>
  <script src="/__asd_history/firm.js"></script>
  <script src="/__asd_history/portfolio.js"></script>
  <script src="/__asd_history/team.js"></script>
  <script src="/__asd_history/bookmarks.js"></script>
  <script src="/__asd_history/commands.js"></script>
  <script src="/__asd_history/fs.js"></script>
  <script src="/__asd_history/jobs.js"></script>
  <script src="/__asd_history/history-browser-fixture.js"></script>
</body>
</html>
`;

const fixtureDir = path.join(dist, "__asd_history");
fs.mkdirSync(fixtureDir, { recursive: true });
for (const source of [
  "js/history.js",
  "js/pipeline.js",
  "js/terminal-ext.js",
  "js/terminal.js",
  "js/ascii-art.js",
  "config/help.js",
  "config/firm.js",
  "config/portfolio.js",
  "config/team.js",
  "js/bookmarks.js",
  "config/commands.js",
  "config/fs.js",
  "config/jobs.js",
]) {
  fs.copyFileSync(path.join(root, source), path.join(fixtureDir, path.basename(source)));
}
fs.copyFileSync(
  path.join(root, "node_modules/@xterm/xterm/lib/xterm.js"),
  path.join(fixtureDir, "xterm.js")
);
fs.copyFileSync(
  path.join(root, "node_modules/@xterm/xterm/css/xterm.css"),
  path.join(fixtureDir, "xterm.css")
);
fs.copyFileSync(fixtureSource, path.join(fixtureDir, "history-browser-fixture.js"));
fs.writeFileSync(path.join(dist, "__asd_history.html"), html);

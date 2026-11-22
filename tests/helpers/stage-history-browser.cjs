const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const target = path.join(root, "dist", "__history-tests");
fs.mkdirSync(target, { recursive: true });

for (const [source, destination] of [
  ["js/command-history.js", "command-history.js"],
  ["tests/browser/history-store.html", "history-store.html"],
  ["tests/browser/history-store.js", "history-store.js"],
  ["js/pipeline.js", "pipeline.js"],
  ["js/terminal.js", "terminal.js"],
  ["js/terminal-ext.js", "terminal-ext.js"],
  ["js/bookmarks.js", "bookmarks.js"],
  ["config/help.js", "help.js"],
  ["config/firm.js", "firm.js"],
  ["config/portfolio.js", "portfolio.js"],
  ["config/team.js", "team.js"],
  ["config/commands.js", "commands.js"],
  ["config/fs.js", "fs.js"],
  ["config/jobs.js", "jobs.js"],
  ["tests/browser/history-terminal.html", "history-terminal.html"],
  ["tests/browser/history-terminal.js", "history-terminal.js"],
  ["tests/browser/history-startup.html", "history-startup.html"],
  ["tests/browser/history-startup.js", "history-startup.js"],
]) {
  fs.copyFileSync(path.join(root, source), path.join(target, destination));
}

const dist = path.join(root, "dist");
const fingerprinted = fs.readdirSync(path.join(dist, "static"));
for (const [prefix, destination] of [
  ["xterm.", "xterm.js"],
  ["addon-fit.", "addon-fit.js"],
  ["addon-web-links.", "addon-web-links.js"],
  ["app.bundle.", "app.js"],
]) {
  const source = fingerprinted.find((name) => name.startsWith(prefix));
  if (!source) throw new Error(`Missing built startup asset: ${prefix}`);
  fs.copyFileSync(path.join(dist, "static", source), path.join(target, destination));
}
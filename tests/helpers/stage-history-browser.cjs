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
]) {
  fs.copyFileSync(path.join(root, source), path.join(target, destination));
}
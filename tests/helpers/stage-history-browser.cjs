const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const target = path.join(root, "dist", "__history-tests");
fs.mkdirSync(target, { recursive: true });

for (const [source, destination] of [
  ["js/command-history.js", "command-history.js"],
  ["tests/browser/history-store.html", "history-store.html"],
  ["tests/browser/history-store.js", "history-store.js"],
]) {
  fs.copyFileSync(path.join(root, source), path.join(target, destination));
}
// Shared reference content for the Terminal tips panel. This remains a classic
// browser script and is also exported for the pure Node tests below.
const terminalTips = Object.freeze([
  Object.freeze({
    title: "help",
    description: "Type help to list commands.",
  }),
  Object.freeze({
    title: "version",
    description: "Type version to view build identity.",
  }),
  Object.freeze({
    title: "shortcuts",
    description: "Type man shortcuts to view editing shortcuts.",
  }),
]);

function filterTerminalTips(query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return terminalTips;

  return terminalTips.filter((tip) =>
    `${tip.title} ${tip.description}`.toLowerCase().includes(normalizedQuery)
  );
}

// Dual-mode; see the note in config/firm.js. Inert in a browser.
if (typeof module !== "undefined") {
  module.exports = { terminalTips, filterTerminalTips };
}

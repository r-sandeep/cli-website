const TERMINAL_TIPS_NO_MATCH = "No matching tips";

const terminalTips = Object.freeze([
  Object.freeze({
    id: "help",
    title: "help",
    description: "type help to list commands",
  }),
  Object.freeze({
    id: "version",
    title: "version",
    description: "type version to view build identity",
  }),
  Object.freeze({
    id: "shortcuts",
    title: "shortcuts",
    description: "type man shortcuts to view editing shortcuts",
  }),
]);

function filterTerminalTips(query) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  if (!normalizedQuery) return terminalTips;

  return terminalTips.filter(
    (tip) =>
      tip.title.toLowerCase().includes(normalizedQuery) ||
      tip.description.toLowerCase().includes(normalizedQuery)
  );
}

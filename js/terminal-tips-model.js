const terminalTips = Object.freeze([
  Object.freeze({
    title: "help",
    description: "type help to list commands",
  }),
  Object.freeze({
    title: "version",
    description: "type version to view build identity",
  }),
  Object.freeze({
    title: "shortcuts",
    description: "type man shortcuts to view editing shortcuts",
  }),
]);

function filterTerminalTips(query) {
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery === "") {
    return terminalTips;
  }

  return terminalTips.filter((tip) =>
    `${tip.title} ${tip.description}`.toLowerCase().includes(normalizedQuery)
  );
}

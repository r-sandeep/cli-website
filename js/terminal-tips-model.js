// Shared terminal tips data and filtering for classic-script consumers.
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

const filterTerminalTips = (query) => {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();

  if (normalizedQuery === "") return terminalTips.slice();

  return terminalTips.filter(
    ({ title, description }) =>
      title.toLowerCase().includes(normalizedQuery) ||
      description.toLowerCase().includes(normalizedQuery)
  );
};
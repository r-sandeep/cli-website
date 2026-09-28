// Public commands are derived from the displayed help registry. A command is
// public only when its help key starts with a %name% presentation marker.
function publicCommandText(value) {
  return String(value)
    .replace(/%([^%]+)%/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function createPublicCommandCatalog(helpEntries) {
  const descriptionsByName = new Map();

  Object.entries(helpEntries).forEach(function (entry) {
    const marker = entry[0].match(/^%([^%]+)%/);
    if (!marker) return;

    const name = publicCommandText(marker[1]);
    if (!name) return;

    const description = publicCommandText(entry[1]);
    const descriptions = descriptionsByName.get(name) || [];
    if (description && !descriptions.includes(description)) {
      descriptions.push(description);
    }
    descriptionsByName.set(name, descriptions);
  });

  return Object.freeze(
    Array.from(descriptionsByName.entries())
      .sort(function (left, right) {
        if (left[0] < right[0]) return -1;
        if (left[0] > right[0]) return 1;
        return 0;
      })
      .map(function (entry) {
        return Object.freeze({
          name: entry[0],
          description: entry[1].join("; "),
        });
      })
  );
}

const publicCommandHelp =
  typeof help !== "undefined" ? help : require("./help").help;
const publicCommands = createPublicCommandCatalog(publicCommandHelp);

function searchPublicCommands(query) {
  const needle = String(query == null ? "" : query).trim().toLowerCase();
  if (!needle) return publicCommands.slice();

  return publicCommands.filter(function (command) {
    return (
      command.name.toLowerCase().includes(needle) ||
      command.description.toLowerCase().includes(needle)
    );
  });
}

if (typeof module !== "undefined") module.exports = {
  createPublicCommandCatalog,
  publicCommandText,
  publicCommands,
  searchPublicCommands,
};

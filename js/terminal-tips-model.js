// Shared, side-effect-free data and filtering for Terminal tips.
var TerminalTips = (function () {
  var tips = Object.freeze([
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

  function filterTips(query) {
    var normalizedQuery = String(query == null ? "" : query)
      .trim()
      .toLowerCase();

    if (!normalizedQuery) return tips.slice();

    return tips.filter(function (tip) {
      return (
        tip.title.toLowerCase().includes(normalizedQuery) ||
        tip.description.toLowerCase().includes(normalizedQuery)
      );
    });
  }

  return Object.freeze({
    tips: tips,
    filterTips: filterTips,
  });
})();

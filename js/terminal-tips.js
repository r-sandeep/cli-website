(function () {
  var toggle = document.getElementById("terminal-tips-toggle");
  var panel = document.getElementById("terminal-tips-panel");
  var search = document.getElementById("terminal-tips-search");
  var results = document.getElementById("terminal-tips-results");
  var status = document.getElementById("terminal-tips-status");
  var closeButton = document.getElementById("terminal-tips-close");

  if (!toggle || !panel || !search || !results || !status || !closeButton) {
    return;
  }

  function appendTip(tip) {
    var item = document.createElement("p");
    var title = document.createElement("span");
    var description = document.createElement("span");

    item.className = "terminal-tip";
    title.className = "terminal-tip-title";
    description.className = "terminal-tip-description";
    title.textContent = tip.title;
    description.textContent = tip.description;
    item.appendChild(title);
    item.appendChild(description);
    results.appendChild(item);
  }

  function render() {
    var matches = TerminalTips.filterTips(search.value);
    results.textContent = "";

    if (matches.length === 0) {
      var empty = document.createElement("p");
      empty.textContent = "No matching tips";
      results.appendChild(empty);
      status.textContent = "No matching tips";
      return;
    }

    matches.forEach(appendTip);
    status.textContent = matches.length === 1 ? "1 tip" : matches.length + " tips";
  }

  function openPanel() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    render();
    search.focus();
  }

  function closePanel() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  toggle.addEventListener("click", function () {
    if (panel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  });

  closeButton.addEventListener("click", closePanel);
  search.addEventListener("input", render);
  panel.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  });

  render();
})();
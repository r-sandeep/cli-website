(() => {
  const toggle = document.getElementById("terminal-tips-toggle");
  const panel = document.getElementById("terminal-tips-panel");
  const search = document.getElementById("terminal-tips-search");
  const results = document.getElementById("terminal-tips-results");
  const status = document.getElementById("terminal-tips-status");
  const closeButton = document.getElementById("terminal-tips-close");

  if (!toggle || !panel || !search || !results || !status || !closeButton) {
    return;
  }

  function renderTips() {
    const matches = filterTerminalTips(search.value);
    results.replaceChildren();

    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No matching tips";
      results.appendChild(empty);
    } else {
      for (const tip of matches) {
        const item = document.createElement("div");
        const title = document.createElement("div");
        const description = document.createElement("div");

        item.className = "terminal-tip";
        title.className = "terminal-tip-title";
        title.textContent = tip.title;
        description.textContent = tip.description;
        item.append(title, description);
        results.appendChild(item);
      }
    }

    status.textContent = `${matches.length} ${matches.length === 1 ? "tip" : "tips"} shown`;
  }

  function openPanel() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    renderTips();
    search.focus();
  }

  function closePanel() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  toggle.addEventListener("click", () => {
    if (panel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  });

  closeButton.addEventListener("click", closePanel);
  search.addEventListener("input", renderTips);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  });

  renderTips();
})();
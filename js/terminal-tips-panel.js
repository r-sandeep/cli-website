function setupTerminalTipsPanel() {
  const toggle = document.getElementById("terminal-tips-toggle");
  const panel = document.getElementById("terminal-tips-panel");
  const search = document.getElementById("terminal-tips-search");
  const results = document.getElementById("terminal-tips-results");
  const status = document.getElementById("terminal-tips-status");
  const closeButton = document.getElementById("terminal-tips-close");

  if (!toggle || !panel || !search || !results || !status || !closeButton) {
    return;
  }

  function render() {
    const matches = filterTerminalTips(search.value);
    results.replaceChildren();

    if (matches.length === 0) {
      results.textContent = TERMINAL_TIPS_NO_MATCH;
      status.textContent = TERMINAL_TIPS_NO_MATCH;
      return;
    }

    for (const tip of matches) {
      const item = document.createElement("p");
      const title = document.createElement("strong");
      item.dataset.tipId = tip.id;
      title.textContent = tip.title;
      item.append(title, document.createTextNode(` — ${tip.description}`));
      results.appendChild(item);
    }

    status.textContent = `${matches.length} ${matches.length === 1 ? "tip" : "tips"} shown`;
  }

  function openPanel() {
    render();
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    search.focus();
  }

  function closePanel() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  toggle.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    else closePanel();
  });
  closeButton.addEventListener("click", closePanel);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePanel();
    }
  });
  search.addEventListener("input", render);

  search.value = "";
  panel.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  render();
}
function initializeTerminalTips(doc = document) {
  const toggle = doc.getElementById("terminal-tips-toggle");
  const panel = doc.getElementById("terminal-tips-panel");
  const search = doc.getElementById("terminal-tips-search");
  const results = doc.getElementById("terminal-tips-results");
  const status = doc.getElementById("terminal-tips-status");
  const closeButton = doc.getElementById("terminal-tips-close");

  if (!toggle || !panel || !search || !results || !status || !closeButton) {
    return;
  }

  function render() {
    const matches = filterTerminalTips(search.value);
    results.replaceChildren();

    if (matches.length === 0) {
      results.textContent = "No matching tips";
      status.textContent = "No matching tips";
      return;
    }

    const list = doc.createElement("ul");
    for (const tip of matches) {
      const item = doc.createElement("li");
      const title = doc.createElement("strong");
      const description = doc.createElement("span");
      title.textContent = tip.title;
      description.textContent = tip.description;
      item.append(title, doc.createTextNode(" — "), description);
      list.appendChild(item);
    }
    results.appendChild(list);
    status.textContent = `${matches.length} ${matches.length === 1 ? "tip" : "tips"} shown`;
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

  toggle.addEventListener("click", () => {
    if (panel.hidden) {
      openPanel();
    } else {
      closePanel();
    }
  });
  closeButton.addEventListener("click", closePanel);
  search.addEventListener("input", () => {
    render();
    search.focus();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      event.preventDefault();
      closePanel();
    }
  });

  panel.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  search.value = "";
  render();
}

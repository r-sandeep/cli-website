function initializeTerminalTipsPanel() {
  const toggle = document.getElementById("terminal-tips-toggle");
  const panel = document.getElementById("terminal-tips-panel");
  const closeButton = document.getElementById("terminal-tips-close");
  const search = document.getElementById("terminal-tips-search");
  const results = document.getElementById("terminal-tips-results");
  const status = document.getElementById("terminal-tips-status");

  function render() {
    const matches = filterTerminalTips(search.value);
    results.replaceChildren();

    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No matching tips.";
      results.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "terminal-tips-list";
      for (const tip of matches) {
        const item = document.createElement("li");
        item.textContent = `${tip.title}: ${tip.description}`;
        list.appendChild(item);
      }
      results.appendChild(list);
    }

    if (!search.value.trim()) {
      status.textContent = `${matches.length} tips`;
    } else {
      status.textContent = `${matches.length} matching ${
        matches.length === 1 ? "tip" : "tips"
      }`;
    }
  }

  function openPanel() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    render();
    search.focus();
  }

  function dismissPanel() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  }

  toggle.addEventListener("click", () => {
    if (panel.hidden) openPanel();
    else dismissPanel();
  });
  closeButton.addEventListener("click", dismissPanel);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") dismissPanel();
  });
  search.addEventListener("input", render);

  panel.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  search.value = "";
  render();
}
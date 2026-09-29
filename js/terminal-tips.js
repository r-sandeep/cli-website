const initTerminalTips = () => {
  const toggle = document.getElementById("terminal-tips-toggle");
  const panel = document.getElementById("terminal-tips-panel");
  const search = document.getElementById("terminal-tips-search");
  const results = document.getElementById("terminal-tips-results");
  const status = document.getElementById("terminal-tips-status");
  const close = document.getElementById("terminal-tips-close");

  const render = () => {
    const matches = filterTerminalTips(search.value);
    results.replaceChildren();

    if (matches.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "No matching tips";
      results.appendChild(empty);
    } else {
      matches.forEach(({ title, description }) => {
        const tip = document.createElement("article");
        const heading = document.createElement("h3");
        const detail = document.createElement("p");

        tip.className = "terminal-tip";
        heading.textContent = title;
        detail.textContent = description;
        tip.append(heading, detail);
        results.appendChild(tip);
      });
    }

    status.textContent = `${matches.length} ${
      matches.length === 1 ? "tip" : "tips"
    }`;
  };

  const dismiss = () => {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.focus();
  };

  const open = () => {
    render();
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    search.focus();
  };

  search.value = "";
  panel.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  render();

  toggle.addEventListener("click", () => {
    if (panel.hidden) open();
    else dismiss();
  });
  close.addEventListener("click", dismiss);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismiss();
    }
  });
  search.addEventListener("input", () => {
    render();
    search.focus();
  });
};

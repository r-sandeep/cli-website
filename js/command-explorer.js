function initializeCommandExplorer(term) {
  const toggle = document.getElementById("command-explorer-toggle");
  const panel = document.getElementById("command-explorer-panel");
  const search = document.getElementById("command-explorer-search");
  const results = document.getElementById("command-explorer-results");
  const status = document.getElementById("command-explorer-status");
  const close = document.getElementById("command-explorer-close");

  if (!toggle || !panel || !search || !results || !status || !close) return;

  function renderResults() {
    const matches = searchPublicCommands(search.value);
    results.replaceChildren();

    matches.forEach(function (command) {
      const button = document.createElement("button");
      const name = document.createElement("span");
      const description = document.createElement("span");

      button.type = "button";
      button.className = "command-explorer-result";
      button.dataset.command = command.name;
      button.setAttribute("aria-label", `Insert ${command.name}`);

      name.className = "command-explorer-result-name";
      name.textContent = `Insert ${command.name}`;
      description.className = "command-explorer-result-description";
      description.textContent = command.description;
      button.append(name, description);
      results.appendChild(button);
    });

    status.textContent = matches.length
      ? `${matches.length} matching ${matches.length === 1 ? "command" : "commands"}`
      : "No matching commands";
  }

  function openExplorer() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    renderResults();
    search.focus();
  }

  function closeExplorer(focusTarget = toggle) {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    focusTarget.focus();
  }

  function insertCommand(commandName) {
    if (!term || term.busy || term.currentLine.length > 0) {
      status.textContent = "Finish or clear the terminal input before inserting a command";
      return;
    }

    term.setCurrentLine(commandName);
    closeExplorer(term);
  }

  toggle.addEventListener("click", function () {
    if (panel.hidden) openExplorer();
    else closeExplorer();
  });
  close.addEventListener("click", function () {
    closeExplorer();
  });
  search.addEventListener("input", renderResults);
  results.addEventListener("click", function (event) {
    const button = event.target.closest("button[data-command]");
    if (button && results.contains(button)) insertCommand(button.dataset.command);
  });
  panel.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeExplorer();
    }
  });
}

if (typeof module !== "undefined") module.exports = { initializeCommandExplorer };
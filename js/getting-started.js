(() => {
  const toggle = document.getElementById("getting-started-toggle");
  const panel = document.getElementById("getting-started-panel");
  const close = document.getElementById("getting-started-close");

  if (!toggle || !panel || !close) {
    return;
  }

  function openPanel() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    close.focus();
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

  close.addEventListener("click", closePanel);

  panel.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      !panel.hidden &&
      panel.contains(document.activeElement)
    ) {
      event.preventDefault();
      closePanel();
    }
  });
})();

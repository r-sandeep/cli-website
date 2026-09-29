(function bootstrapTerminal() {
  const optionalScriptPromises = {};

  function loadOptionalScript(src) {
    if (optionalScriptPromises[src]) {
      return optionalScriptPromises[src];
    }

    optionalScriptPromises[src] = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });

    return optionalScriptPromises[src];
  }

  window.scheduleIdleTask = (task, timeout = 1000) => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => task(), { timeout });
    } else {
      window.setTimeout(task, timeout);
    }
  };

  window.ensureAALibLoaded = () => loadOptionalScript("js/aalib.js");
  window.ensureRickRollLoaded = () => loadOptionalScript("js/rickroll.min.js");

  function setupGettingStartedPanel() {
    const toggle = document.getElementById("getting-started-toggle");
    const panel = document.getElementById("getting-started-panel");
    const closeButton = document.getElementById("getting-started-close");

    if (!toggle || !panel || !closeButton) {
      return;
    }

    function openPanel() {
      panel.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      closeButton.focus();
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
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closePanel();
      }
    });
  }

  setupGettingStartedPanel();

  const terminalElement = document.getElementById("terminal");
  const term = new Terminal({ cursorBlink: true });
  const fitAddon = new FitAddon.FitAddon();
  const webLinksAddon = new WebLinksAddon.WebLinksAddon();

  window.term = term;
  window.fitAddon = fitAddon;

  term.open(terminalElement);
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);
  extend(term);
  window.deepLinkAssetPromise = Promise.resolve();
  if (term.deepLink) {
    window.deepLinkAssetPromise = term.preloadCommandAssets(term.deepLink).catch(
      (error) => {
        console.warn("Failed to preload deep link assets", error);
      }
    );
  }
  runRootTerminal(term);

  window.scheduleIdleTask(() => {
    preloadASCIIArt();
    preloadFiles();
  }, 1500);
})();

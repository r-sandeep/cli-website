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

  const gettingStartedToggle = document.getElementById(
    "getting-started-toggle"
  );
  const gettingStartedPanel = document.getElementById("getting-started-panel");
  const gettingStartedClose = document.getElementById("getting-started-close");

  function setGettingStartedOpen(open) {
    gettingStartedPanel.hidden = !open;
    gettingStartedToggle.setAttribute("aria-expanded", String(open));
    (open ? gettingStartedClose : gettingStartedToggle).focus();
  }

  gettingStartedToggle.addEventListener("click", () => {
    setGettingStartedOpen(gettingStartedPanel.hidden);
  });
  gettingStartedClose.addEventListener("click", () => {
    setGettingStartedOpen(false);
  });
  gettingStartedPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !gettingStartedPanel.hidden) {
      event.preventDefault();
      setGettingStartedOpen(false);
    }
  });

  window.scheduleIdleTask(() => {
    preloadASCIIArt();
    preloadFiles();
  }, 1500);
})();

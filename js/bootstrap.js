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

  const settingsToggle = document.getElementById("terminal-settings-toggle");
  const settingsPanel = document.getElementById("terminal-settings");
  const fontSizeInput = document.getElementById("terminal-font-size");
  const cursorBlinkInput = document.getElementById("terminal-cursor-blink");
  const screenReaderInput = document.getElementById("terminal-screen-reader");
  const settingsSave = document.getElementById("terminal-settings-save");
  const settingsReset = document.getElementById("terminal-settings-reset");
  const settingsClose = document.getElementById("terminal-settings-close");
  const settingsStatus = document.getElementById("terminal-settings-status");

  function setSettingsStatus(message, isError = false) {
    settingsStatus.textContent = message;
    if (message) {
      settingsStatus.dataset.state = isError ? "error" : "success";
    } else {
      delete settingsStatus.dataset.state;
    }
  }

  function renderCommittedPreferences() {
    const preferences = term.preferences.snapshot();
    if (!preferences) {
      const status = term.preferences.status();
      setSettingsStatus(status.message, true);
      return null;
    }
    fontSizeInput.value = String(preferences.fontSize);
    cursorBlinkInput.checked = preferences.cursorBlink;
    screenReaderInput.checked = preferences.screenReaderMode;
    return preferences;
  }

  function openSettings() {
    setSettingsStatus("");
    renderCommittedPreferences();
    settingsPanel.hidden = false;
    settingsToggle.setAttribute("aria-expanded", "true");
    fontSizeInput.focus();
  }

  function closeSettings() {
    settingsPanel.hidden = true;
    settingsToggle.setAttribute("aria-expanded", "false");
    settingsToggle.focus();
  }

  settingsToggle.addEventListener("click", openSettings);
  settingsClose.addEventListener("click", closeSettings);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !settingsPanel.hidden) {
      event.preventDefault();
      closeSettings();
    }
  });

  settingsSave.addEventListener("click", () => {
    const fontSize = Number(fontSizeInput.value);
    if (!Number.isInteger(fontSize) || fontSize < 12 || fontSize > 24) {
      setSettingsStatus("Font size must be an integer from 12 to 24", true);
      return;
    }

    const committed = term.preferences.snapshot();
    if (!committed) {
      setSettingsStatus(term.preferences.status().message, true);
      return;
    }
    const result = term.preferences.update({
      version: committed.version,
      fontSize,
      cursorBlink: cursorBlinkInput.checked,
      screenReaderMode: screenReaderInput.checked,
    });
    if (!result.ok) {
      setSettingsStatus(result.message, true);
      return;
    }
    renderCommittedPreferences();
    setSettingsStatus("Preferences saved");
  });

  settingsReset.addEventListener("click", () => {
    const result = term.preferences.reset();
    if (!result.ok) {
      setSettingsStatus(result.message, true);
      return;
    }
    renderCommittedPreferences();
    setSettingsStatus("Preferences reset");
  });

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

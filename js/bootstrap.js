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

  // Canvas-rendered xterm output is not exposed as line-delimited DOM text.
  // Keep a semantic transcript in the screen so assistive technology can read
  // the same logical lines that are visible on the canvas.
  const screen = terminalElement.querySelector(".xterm-screen");
  if (screen && term.buffer && typeof term.onWriteParsed === "function") {
    const transcript = document.createElement("pre");
    transcript.className = "terminal-transcript visually-hidden";
    transcript.setAttribute("role", "log");
    transcript.setAttribute("aria-label", "Terminal transcript");
    screen.appendChild(transcript);

    const updateTranscript = () => {
      const buffer = term.buffer.active;
      const lines = [];
      let logicalLine = "";
      for (let index = 0; index < buffer.length; index++) {
        const line = buffer.getLine(index);
        if (!line) continue;
        if (!line.isWrapped && logicalLine !== "") {
          lines.push(logicalLine);
          logicalLine = "";
        }
        logicalLine += line.translateToString(true);
      }
      lines.push(logicalLine);
      transcript.textContent = `${lines.join("\n")}\n`;
    };

    term.onWriteParsed(updateTranscript);
    updateTranscript();
  }

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

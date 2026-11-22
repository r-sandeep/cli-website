(() => {
  "use strict";

  const waitFor = async (predicate, message) => {
    for (let count = 0; count < 180; count += 1) {
      if (predicate()) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    throw new Error(message);
  };

  const observedOutput = [];
  let observedPrompts = 0;
  const originalStylePrint = window.term?.stylePrint;
  const originalPrompt = window.term?.prompt;
  if (originalStylePrint) {
    window.term.stylePrint = (...args) => {
      observedOutput.push(String(args[0]));
      return originalStylePrint.apply(window.term, args);
    };
  }
  if (originalPrompt) {
    window.term.prompt = (...args) => {
      observedPrompts += 1;
      return originalPrompt.apply(window.term, args);
    };
  }

  (async () => {
    try {
      await waitFor(
        () => window.term && window.terminalReadyPromise,
        "production bootstrap did not expose terminal readiness",
      );
      await window.terminalReadyPromise;
      await waitFor(
        () => window.term?._initialized === true,
        "silent IndexedDB open prevented terminal initialization",
      );
      if (window.location.hash === "#ping") {
        await window.deepLinkAssetPromise;
        await waitFor(
          () => observedOutput.includes("pong"),
          "deep-link command did not run after storage fallback",
        );
        if (window.term.history.includes("ping")) {
          throw new Error("deep-link execution was added to submitted history");
        }
      }
      window.parent.postMessage({
        type: "history-startup-pass",
        history: window.term.history.slice(),
        promptCount: observedPrompts,
      }, "*");
    } catch (error) {
      window.parent.postMessage({ type: "history-startup-fail", message: error.message }, "*");
      throw error;
    }
  })();
})();

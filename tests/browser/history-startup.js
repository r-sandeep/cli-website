(() => {
  "use strict";

  const waitFor = async (predicate, message) => {
    for (let count = 0; count < 180; count += 1) {
      if (predicate()) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    throw new Error(message);
  };

  (async () => {
    try {
      await waitFor(
        () => window.term && window.terminalReadyPromise,
        "production bootstrap did not expose terminal readiness",
      );
      await window.terminalReadyPromise;
      await waitFor(
        () => document.querySelector(".xterm-screen")?.textContent.includes("guest:rootpc ~ $"),
        "silent IndexedDB open prevented the first prompt",
      );
      if (window.location.hash === "#ping") {
        await window.deepLinkAssetPromise;
        await waitFor(
          () => document.querySelector(".xterm-screen")?.textContent.includes("pong"),
          "deep-link command did not run after storage fallback",
        );
        if (window.term.history.includes("ping")) {
          throw new Error("deep-link execution was added to submitted history");
        }
      }
      window.parent.postMessage({
        type: "history-startup-pass",
        history: window.term.history.slice(),
        promptCount: (document.querySelector(".xterm-screen")?.textContent.match(/guest:rootpc ~ \$/g) || []).length,
      }, "*");
    } catch (error) {
      window.parent.postMessage({ type: "history-startup-fail", message: error.message }, "*");
      throw error;
    }
  })();
})();

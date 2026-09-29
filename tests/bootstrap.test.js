import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadBootstrap(overrides = {}) {
  const terminalStateSentinel = { output: "existing terminal state" };
  const term = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    terminalStateSentinel,
  };
  const fitAddon = { fit: vi.fn() };
  const webLinksAddon = { open: vi.fn() };
  const preloadCommandAssets = vi.fn(() => Promise.resolve());
  const extend = vi.fn((instance) => {
    instance.deepLink = "whois lee";
    instance.preloadCommandAssets = preloadCommandAssets;
  });
  const runRootTerminal = vi.fn();
  const preloadASCIIArt = vi.fn();
  const preloadFiles = vi.fn();
  const idleCalls = [];
  const requestIdleCallback = vi.fn((task, options) => {
    idleCalls.push({ options, task });
  });
  const Terminal = vi.fn(function Terminal() {
    return term;
  });
  const FitAddonCtor = vi.fn(function FitAddon() {
    return fitAddon;
  });
  const WebLinksAddonCtor = vi.fn(function WebLinksAddon() {
    return webLinksAddon;
  });

  env = createBrowserEnv({
    html: `
      <!doctype html>
      <html>
        <head></head>
        <body>
          <div id="terminal"></div>
          <button
            id="getting-started-toggle"
            type="button"
            aria-controls="getting-started-panel"
            aria-expanded="false"
          >Getting started</button>
          <section
            id="getting-started-panel"
            role="dialog"
            aria-modal="false"
            aria-labelledby="getting-started-title"
            hidden
          >
            <h2 id="getting-started-title">Getting started</h2>
            <p>Type help in the terminal to see available commands.</p>
            <button id="getting-started-close" type="button">Close</button>
          </section>
        </body>
      </html>
    `,
    url: "https://www.root.vc/#whois-lee",
    globals: {
      FitAddon: { FitAddon: FitAddonCtor },
      Terminal,
      WebLinksAddon: { WebLinksAddon: WebLinksAddonCtor },
      extend,
      preloadASCIIArt,
      preloadFiles,
      requestIdleCallback,
      runRootTerminal,
      ...overrides,
    },
  });

  env.loadScripts(["js/bootstrap.js"]);

  return {
    extend,
    fitAddon,
    idleCalls,
    preloadASCIIArt,
    preloadCommandAssets,
    preloadFiles,
    requestIdleCallback,
    runRootTerminal,
    term,
    terminalStateSentinel,
    Terminal,
    webLinksAddon,
  };
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("bootstrap", () => {
  it("boots the terminal and preloads deep-link assets before idle work", async () => {
    const state = loadBootstrap();

    await env.window.deepLinkAssetPromise;

    expect(state.term.open).toHaveBeenCalledWith(
      env.document.getElementById("terminal")
    );
    expect(state.term.loadAddon).toHaveBeenNthCalledWith(1, state.fitAddon);
    expect(state.term.loadAddon).toHaveBeenNthCalledWith(
      2,
      state.webLinksAddon
    );
    expect(state.extend).toHaveBeenCalledWith(state.term);
    expect(state.preloadCommandAssets).toHaveBeenCalledWith("whois lee");
    expect(state.runRootTerminal).toHaveBeenCalledWith(state.term);
    expect(state.idleCalls).toHaveLength(1);
    expect(state.idleCalls[0].options).toEqual({ timeout: 1500 });

    state.idleCalls[0].task();

    expect(state.preloadASCIIArt).toHaveBeenCalledTimes(1);
    expect(state.preloadFiles).toHaveBeenCalledTimes(1);
  });

  it("opens and closes the panel through every route without replacing terminal state", () => {
    const state = loadBootstrap();
    const terminalElement = env.document.getElementById("terminal");
    const toggle = env.document.getElementById("getting-started-toggle");
    const panel = env.document.getElementById("getting-started-panel");
    const close = env.document.getElementById("getting-started-close");
    const expectTerminalPreserved = () => {
      expect(env.document.getElementById("terminal")).toBe(terminalElement);
      expect(env.window.term).toBe(state.term);
      expect(state.term.terminalStateSentinel).toBe(
        state.terminalStateSentinel
      );
      expect(state.Terminal).toHaveBeenCalledTimes(1);
      expect(state.term.open).toHaveBeenCalledTimes(1);
      expect(state.term.open).toHaveBeenCalledWith(terminalElement);
    };

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expectTerminalPreserved();

    const closedOutsideEscape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    toggle.dispatchEvent(closedOutsideEscape);
    expect(closedOutsideEscape.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expectTerminalPreserved();

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);
    expectTerminalPreserved();

    close.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);
    expectTerminalPreserved();

    toggle.click();
    const openPanelEscape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    close.dispatchEvent(openPanelEscape);
    expect(openPanelEscape.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);
    expectTerminalPreserved();

    toggle.click();
    toggle.focus();
    const openOutsideEscape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    toggle.dispatchEvent(openOutsideEscape);
    expect(openOutsideEscape.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(toggle);
    expectTerminalPreserved();

    toggle.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);
    expectTerminalPreserved();
  });

  it("keeps repeated and interleaved panel transitions deterministic", () => {
    const state = loadBootstrap();
    const terminalElement = env.document.getElementById("terminal");
    const toggle = env.document.getElementById("getting-started-toggle");
    const panel = env.document.getElementById("getting-started-panel");
    const close = env.document.getElementById("getting-started-close");

    toggle.click();
    close.click();
    toggle.click();
    close.dispatchEvent(
      new env.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
      })
    );
    toggle.click();
    toggle.click();
    toggle.click();

    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);

    close.click();

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);
    expect(env.document.getElementById("terminal")).toBe(terminalElement);
    expect(env.window.term).toBe(state.term);
    expect(state.term.terminalStateSentinel).toBe(
      state.terminalStateSentinel
    );
    expect(state.Terminal).toHaveBeenCalledTimes(1);
    expect(state.term.open).toHaveBeenCalledTimes(1);
  });

  it("deduplicates optional script loading for aalib and rickroll", async () => {
    const state = loadBootstrap();
    const originalAppendChild = env.document.head.appendChild.bind(
      env.document.head
    );
    const appendedScripts = [];

    vi.spyOn(env.document.head, "appendChild").mockImplementation((node) => {
      appendedScripts.push(node);
      return originalAppendChild(node);
    });

    const aalibFirst = env.window.ensureAALibLoaded();
    const aalibSecond = env.window.ensureAALibLoaded();

    expect(aalibFirst).toBe(aalibSecond);
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0].src).toBe("https://www.root.vc/js/aalib.js");

    appendedScripts[0].onload();
    await aalibFirst;

    const rickrollPromise = env.window.ensureRickRollLoaded();

    expect(appendedScripts).toHaveLength(2);
    expect(appendedScripts[1].src).toBe(
      "https://www.root.vc/js/rickroll.min.js"
    );

    appendedScripts[1].onload();
    await rickrollPromise;
  });
});

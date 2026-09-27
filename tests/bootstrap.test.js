import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadBootstrap(overrides = {}) {
  const term = {
    loadAddon: vi.fn(),
    open: vi.fn(),
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
          <div id="terminal">
            <div class="xterm-screen">terminal output</div>
            <textarea class="xterm-helper-textarea"></textarea>
          </div>
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
            <p>Type help in the terminal to see the available commands.</p>
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

  it("opens and closes the panel without disturbing the terminal", () => {
    const state = loadBootstrap();
    const toggle = env.document.getElementById("getting-started-toggle");
    const panel = env.document.getElementById("getting-started-panel");
    const close = env.document.getElementById("getting-started-close");
    const terminal = env.document.getElementById("terminal");
    const terminalInput = terminal.querySelector(".xterm-helper-textarea");
    const terminalMarkup = terminal.innerHTML;
    const bootstrapGlobals = Object.keys(env.window).sort();

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.click();

    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);

    terminalInput.focus();
    const outsideEscape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });

    expect(terminalInput.dispatchEvent(outsideEscape)).toBe(true);
    expect(outsideEscape.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(terminalInput);

    close.click();

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);

    toggle.click();

    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);

    const panelEscape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });

    expect(close.dispatchEvent(panelEscape)).toBe(false);
    expect(panelEscape.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);

    toggle.click();

    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);

    toggle.click();

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);
    expect(env.document.getElementById("terminal")).toBe(terminal);
    expect(terminal.innerHTML).toBe(terminalMarkup);
    expect(state.Terminal).toHaveBeenCalledTimes(1);
    expect(state.term.open).toHaveBeenCalledTimes(1);
    expect(state.runRootTerminal).toHaveBeenCalledTimes(1);
    expect(Object.keys(env.window).sort()).toEqual(bootstrapGlobals);
  });
});

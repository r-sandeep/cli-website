import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadBootstrap(overrides = {}) {
  let committedPreferences = {
    version: 1,
    fontSize: 15,
    cursorBlink: true,
    screenReaderMode: false,
  };
  const preferences =
    overrides.preferences ||
    {
      snapshot: vi.fn(() => ({ ...committedPreferences })),
      status: vi.fn(() => ({ ok: true, message: "" })),
      update: vi.fn((candidate) => {
        committedPreferences = { ...candidate };
        return { ok: true, code: "updated", message: "" };
      }),
      reset: vi.fn(() => {
        committedPreferences = {
          version: 1,
          fontSize: 15,
          cursorBlink: true,
          screenReaderMode: false,
        };
        return { ok: true, code: "updated", message: "" };
      }),
    };
  const term = {
    loadAddon: vi.fn(),
    open: vi.fn(),
    preferences,
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
          <button id="terminal-settings-toggle" aria-controls="terminal-settings" aria-expanded="false">Terminal settings</button>
          <section id="terminal-settings" aria-labelledby="terminal-settings-title" tabindex="-1" hidden>
            <h2 id="terminal-settings-title">Terminal settings</h2>
            <label for="terminal-font-size">Font size</label>
            <input id="terminal-font-size" type="number" min="12" max="24" />
            <label for="terminal-cursor-blink"><input id="terminal-cursor-blink" type="checkbox" /> Blink cursor</label>
            <label for="terminal-screen-reader"><input id="terminal-screen-reader" type="checkbox" /> Screen reader mode</label>
            <button id="terminal-settings-save">Save</button>
            <button id="terminal-settings-reset">Reset to defaults</button>
            <button id="terminal-settings-close">Close</button>
            <p id="terminal-settings-status" role="status" aria-live="polite"></p>
          </section>
          <div id="terminal"></div>
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
    preferences,
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

  it("starts with a hidden labelled nonmodal settings panel and labelled controls", () => {
    loadBootstrap();

    const panel = env.document.getElementById("terminal-settings");
    const toggle = env.document.getElementById("terminal-settings-toggle");
    const fontSize = env.document.getElementById("terminal-font-size");
    const cursorBlink = env.document.getElementById("terminal-cursor-blink");
    const screenReader = env.document.getElementById("terminal-screen-reader");
    const status = env.document.getElementById("terminal-settings-status");

    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute("aria-labelledby")).toBe("terminal-settings-title");
    expect(panel.hasAttribute("aria-modal")).toBe(false);
    expect(toggle.getAttribute("aria-controls")).toBe("terminal-settings");
    expect(env.document.querySelector('label[for="terminal-font-size"]')).not.toBeNull();
    expect(env.document.querySelector('label[for="terminal-cursor-blink"]')).not.toBeNull();
    expect(env.document.querySelector('label[for="terminal-screen-reader"]')).not.toBeNull();
    expect(fontSize.type).toBe("number");
    expect(cursorBlink.type).toBe("checkbox");
    expect(screenReader.type).toBe("checkbox");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("opens from committed values and Close discards drafts and returns focus", () => {
    const state = loadBootstrap();
    const toggle = env.document.getElementById("terminal-settings-toggle");
    const panel = env.document.getElementById("terminal-settings");
    const fontSize = env.document.getElementById("terminal-font-size");

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(fontSize.value).toBe("15");
    expect(env.document.activeElement).toBe(fontSize);

    fontSize.value = "22";
    env.document.getElementById("terminal-settings-close").click();
    expect(panel.hidden).toBe(true);
    expect(env.document.activeElement).toBe(toggle);
    expect(state.preferences.update).not.toHaveBeenCalled();

    toggle.click();
    expect(fontSize.value).toBe("15");
  });

  it("Escape discards drafts and returns focus to the opener", () => {
    const state = loadBootstrap();
    const toggle = env.document.getElementById("terminal-settings-toggle");
    const panel = env.document.getElementById("terminal-settings");

    toggle.click();
    env.document.getElementById("terminal-font-size").value = "22";
    panel.dispatchEvent(
      new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );

    expect(panel.hidden).toBe(true);
    expect(env.document.activeElement).toBe(toggle);
    expect(state.preferences.update).not.toHaveBeenCalled();
  });

  it("saves a valid draft and refreshes command-originated changes on reopen", () => {
    const state = loadBootstrap();
    const toggle = env.document.getElementById("terminal-settings-toggle");
    const fontSize = env.document.getElementById("terminal-font-size");
    const cursorBlink = env.document.getElementById("terminal-cursor-blink");
    const screenReader = env.document.getElementById("terminal-screen-reader");
    const status = env.document.getElementById("terminal-settings-status");

    toggle.click();
    fontSize.value = "18";
    cursorBlink.checked = false;
    screenReader.checked = true;
    env.document.getElementById("terminal-settings-save").click();

    expect(state.preferences.update).toHaveBeenCalledWith({
      version: 1,
      fontSize: 18,
      cursorBlink: false,
      screenReaderMode: true,
    });
    expect(status.textContent).toBe("Preferences saved");

    state.preferences.update({
      version: 1,
      fontSize: 20,
      cursorBlink: true,
      screenReaderMode: false,
    });
    env.document.getElementById("terminal-settings-close").click();
    toggle.click();
    expect(fontSize.value).toBe("20");
    expect(cursorBlink.checked).toBe(true);
    expect(screenReader.checked).toBe(false);
  });

  it("rejects invalid drafts without mutation or a success claim", () => {
    const state = loadBootstrap();
    const toggle = env.document.getElementById("terminal-settings-toggle");
    const fontSize = env.document.getElementById("terminal-font-size");
    const status = env.document.getElementById("terminal-settings-status");

    toggle.click();
    fontSize.value = "30";
    env.document.getElementById("terminal-settings-save").click();

    expect(state.preferences.update).not.toHaveBeenCalled();
    expect(status.textContent).toBe("Font size must be an integer from 12 to 24");
    expect(status.textContent).not.toContain("Preferences saved");
    expect(status.dataset.state).toBe("error");
  });

  it("shows mutation errors without success and Reset is the explicit reset gesture", () => {
    const preferences = {
      snapshot: vi.fn(() => ({
        version: 1,
        fontSize: 15,
        cursorBlink: true,
        screenReaderMode: false,
      })),
      status: vi.fn(() => ({ ok: true, message: "" })),
      update: vi.fn(() => ({
        ok: false,
        code: "storage",
        message: "Preferences could not be saved because storage is unavailable.",
      })),
      reset: vi.fn(() => ({ ok: true, code: "unchanged", message: "" })),
    };
    loadBootstrap({ preferences });
    const toggle = env.document.getElementById("terminal-settings-toggle");
    const status = env.document.getElementById("terminal-settings-status");

    toggle.click();
    env.document.getElementById("terminal-font-size").value = "18";
    env.document.getElementById("terminal-settings-save").click();
    expect(preferences.update).toHaveBeenCalledTimes(1);
    expect(status.textContent).toContain("storage is unavailable");
    expect(status.textContent).not.toContain("Preferences saved");

    env.document.getElementById("terminal-settings-reset").click();
    expect(preferences.reset).toHaveBeenCalledTimes(1);
    expect(status.textContent).toBe("Preferences reset");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

const tipsMarkup = `
  <!doctype html>
  <html>
    <body>
      <div id="terminal"></div>
      <button id="terminal-tips-toggle" type="button" aria-expanded="false">
        Terminal tips
      </button>
      <section id="terminal-tips-panel" hidden>
        <button id="terminal-tips-close" type="button">Close</button>
        <label for="terminal-tips-search">Search terminal tips</label>
        <input id="terminal-tips-search" type="search" />
        <div id="terminal-tips-results"></div>
        <p id="terminal-tips-status" role="status" aria-live="polite"></p>
      </section>
    </body>
  </html>
`;

function loadTipsUi() {
  const tabHandler = () => true;
  const terminal = {
    _customKeyHandler: tabHandler,
    attachCustomKeyEventHandler: vi.fn(),
    clear: vi.fn(),
    currentLine: "echo q",
    executeCommandLine: vi.fn(),
    init: vi.fn(),
    reset: vi.fn(),
    setCurrentLine: vi.fn(),
  };

  env = createBrowserEnv({
    html: tipsMarkup,
    globals: { term: terminal },
  });
  env.document.getElementById("terminal").textContent = "echo z\nz";
  const storageSet = vi.spyOn(env.window.Storage.prototype, "setItem");
  env.loadScripts(["js/terminal-tips.js", "js/terminal-tips-ui.js"]);
  const { initializeTerminalTips } = env.exportValues([
    "initializeTerminalTips",
  ]);
  initializeTerminalTips();

  return {
    close: env.document.getElementById("terminal-tips-close"),
    panel: env.document.getElementById("terminal-tips-panel"),
    results: env.document.getElementById("terminal-tips-results"),
    search: env.document.getElementById("terminal-tips-search"),
    status: env.document.getElementById("terminal-tips-status"),
    storageSet,
    tabHandler,
    terminal,
    terminalNode: env.document.getElementById("terminal"),
    toggle: env.document.getElementById("terminal-tips-toggle"),
  };
}

function expectTerminalUntouched(state) {
  expect(state.terminal.executeCommandLine).not.toHaveBeenCalled();
  expect(state.terminal.setCurrentLine).not.toHaveBeenCalled();
  expect(state.terminal.clear).not.toHaveBeenCalled();
  expect(state.terminal.reset).not.toHaveBeenCalled();
  expect(state.terminal.init).not.toHaveBeenCalled();
  expect(state.terminal.attachCustomKeyEventHandler).not.toHaveBeenCalled();
  expect(state.storageSet).not.toHaveBeenCalled();
  expect(env.document.getElementById("terminal")).toBe(state.terminalNode);
  expect(state.terminalNode.textContent).toBe("echo z\nz");
  expect(state.terminal.currentLine).toBe("echo q");
  expect(state.terminal._customKeyHandler).toBe(state.tabHandler);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
  vi.restoreAllMocks();
});

describe("terminal tips UI", () => {
  it("starts hidden and renders all exact tips with a polite count", () => {
    const state = loadTipsUi();

    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(state.search.value).toBe("");
    expect(state.results.querySelectorAll("li")).toHaveLength(3);
    expect(state.results.textContent).toContain("type help to list commands");
    expect(state.results.textContent).toContain(
      "type version to view build identity"
    );
    expect(state.results.textContent).toContain(
      "type man shortcuts to view editing shortcuts"
    );
    expect(state.status.textContent).toBe("3 tips shown");
    expectTerminalUntouched(state);
  });

  it("opens, filters literally while focused, and preserves the query", () => {
    const state = loadTipsUi();

    state.toggle.click();
    expect(state.panel.hidden).toBe(false);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(state.search);
    expectTerminalUntouched(state);

    state.search.value = " VERSION ";
    state.search.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    expect(env.document.activeElement).toBe(state.search);
    expect(state.results.querySelectorAll("li")).toHaveLength(1);
    expect(state.results.textContent).toContain(
      "type version to view build identity"
    );
    expect(state.status.textContent).toBe("1 tip shown");
    expectTerminalUntouched(state);

    state.close.click();
    state.toggle.click();
    expect(state.search.value).toBe(" VERSION ");
    expect(state.results.querySelectorAll("li")).toHaveLength(1);
    expect(env.document.activeElement).toBe(state.search);
    expectTerminalUntouched(state);
  });

  it("shows the unmatched message as text", () => {
    const state = loadTipsUi();
    state.toggle.click();
    state.search.value = ".";
    state.search.dispatchEvent(new env.window.Event("input", { bubbles: true }));

    expect(state.results.textContent).toBe("No matching tips");
    expect(state.results.children).toHaveLength(0);
    expect(state.status.textContent).toBe("No matching tips");
    expect(env.document.activeElement).toBe(state.search);
    expectTerminalUntouched(state);
  });

  it("restores opener focus for Close, toggle, and panel Escape cycles", () => {
    const state = loadTipsUi();

    state.toggle.click();
    state.close.click();
    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(state.toggle);
    expectTerminalUntouched(state);

    state.toggle.click();
    state.toggle.click();
    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(state.toggle);
    expectTerminalUntouched(state);

    state.toggle.click();
    const escape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    state.search.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(state.toggle);
    expectTerminalUntouched(state);
  });

  it("reconstructs a hidden panel with an empty query after reload", () => {
    let state = loadTipsUi();
    state.toggle.click();
    state.search.value = "help";
    state.search.dispatchEvent(new env.window.Event("input", { bubbles: true }));
    expect(state.results.querySelectorAll("li")).toHaveLength(1);
    expectTerminalUntouched(state);

    env.cleanup();
    env = null;
    state = loadTipsUi();
    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(state.search.value).toBe("");
    expect(state.results.querySelectorAll("li")).toHaveLength(3);
    expectTerminalUntouched(state);
  });
});

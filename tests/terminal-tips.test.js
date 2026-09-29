import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv, REPO_ROOT } from "./helpers/browser-env";

let env;

const panelMarkup = fs
  .readFileSync(path.join(REPO_ROOT, "index.html"), "utf8")
  .match(/<aside class="terminal-tips">[\s\S]*?<\/aside>/)[0];

function loadTips(globals = {}) {
  env = createBrowserEnv({
    html: `<!doctype html><html><body>${panelMarkup}<div id="terminal"><span id="terminal-child">output</span></div></body></html>`,
    globals,
  });
  env.loadScripts(["js/terminal-tips-model.js", "js/terminal-tips.js"]);
  const { initTerminalTips } = env.exportValues(["initTerminalTips"]);
  initTerminalTips();

  return {
    close: env.document.getElementById("terminal-tips-close"),
    panel: env.document.getElementById("terminal-tips-panel"),
    results: env.document.getElementById("terminal-tips-results"),
    search: env.document.getElementById("terminal-tips-search"),
    status: env.document.getElementById("terminal-tips-status"),
    terminal: env.document.getElementById("terminal"),
    toggle: env.document.getElementById("terminal-tips-toggle"),
  };
}

function input(search, value) {
  search.value = value;
  search.dispatchEvent(new env.window.Event("input", { bubbles: true }));
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal tips controller", () => {
  it("starts hidden with an empty filter, text results, and a polite status", () => {
    const state = loadTips();

    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(state.search.value).toBe("");
    expect(state.status.getAttribute("role")).toBe("status");
    expect(state.status.getAttribute("aria-live")).toBe("polite");
    expect(state.status.textContent).toBe("3 tips");
    expect(
      Array.from(state.results.querySelectorAll("h3"), (node) => node.textContent)
    ).toEqual(["help", "version", "shortcuts"]);
    expect(state.results.querySelector("script")).toBeNull();
  });

  it("opens with search focus and filters as text without losing focus", () => {
    const state = loadTips();
    state.toggle.click();

    expect(state.panel.hidden).toBe(false);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(state.search);

    input(state.search, "  VIEW BUILD  ");

    expect(env.document.activeElement).toBe(state.search);
    expect(state.status.textContent).toBe("1 tip");
    expect(state.results.textContent).toContain("version");
    expect(state.results.textContent).toContain("type version to view build identity");
    expect(state.results.textContent).not.toContain("shortcuts");

    input(state.search, ".*");
    expect(state.results.textContent).toBe("No matching tips");
    expect(state.status.textContent).toBe("0 tips");
  });

  it.each([
    ["Close", (state) => state.close.click()],
    ["Escape", (state) => state.search.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
    ["toggle", (state) => state.toggle.click()],
  ])("dismisses with %s through the same focus-restoring outcome", (_name, dismiss) => {
    const state = loadTips();
    state.toggle.click();
    dismiss(state);

    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(state.toggle);
  });

  it("preserves the query through repeated cycles and resets in a fresh document", () => {
    let state = loadTips();
    state.toggle.click();
    input(state.search, "  HELP  ");
    state.toggle.click();
    state.toggle.click();

    expect(state.search.value).toBe("  HELP  ");
    expect(state.results.textContent).toContain("type help to list commands");
    expect(env.document.activeElement).toBe(state.search);

    state.toggle.click();
    state.toggle.click();
    expect(state.search.value).toBe("  HELP  ");

    env.cleanup();
    env = null;
    state = loadTips();
    expect(state.panel.hidden).toBe(true);
    expect(state.search.value).toBe("");
    expect(state.status.textContent).toBe("3 tips");
  });

  it("leaves terminal object, DOM, pending state, handlers, and preferences untouched", () => {
    const terminalSession = {
      currentLine: "echo q",
      executeCommandLine: vi.fn(),
      tabHandler: vi.fn(),
      preferences: Object.freeze({ cursorBlink: true }),
    };
    const state = loadTips({ term: terminalSession });
    const terminalChild = state.terminal.firstElementChild;

    state.toggle.click();
    input(state.search, "shortcuts");
    state.close.click();

    expect(terminalSession.executeCommandLine).not.toHaveBeenCalled();
    expect(terminalSession.tabHandler).not.toHaveBeenCalled();
    expect(terminalSession.currentLine).toBe("echo q");
    expect(terminalSession.preferences).toEqual({ cursorBlink: true });
    expect(env.window.term).toBe(terminalSession);
    expect(state.terminal.firstElementChild).toBe(terminalChild);
    expect(state.terminal.textContent).toBe("output");
  });
});

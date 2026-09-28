import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const panelMarkup = `
  <button id="terminal-tips-toggle" aria-controls="terminal-tips-panel" aria-expanded="false">Terminal tips</button>
  <section id="terminal-tips-panel" aria-labelledby="terminal-tips-title" hidden>
    <h2 id="terminal-tips-title">Terminal tips</h2>
    <button id="terminal-tips-close">Close</button>
    <label for="terminal-tips-search">Search terminal tips</label>
    <input id="terminal-tips-search" type="search">
    <p id="terminal-tips-status" role="status" aria-live="polite"></p>
    <div id="terminal-tips-results"></div>
  </section>
  <div id="terminal">existing output<span>echo PEND</span></div>
`;

let env;
let controls;

function setupPanel() {
  const terminalState = {
    pendingInput: "echo PEND",
    execute: vi.fn(),
    clear: vi.fn(),
    open: vi.fn(),
    write: vi.fn(),
  };
  env = createBrowserEnv({
    html: `<!doctype html><html><body>${panelMarkup}</body></html>`,
    globals: { term: terminalState },
  });
  const setItem = vi.spyOn(env.window.Storage.prototype, "setItem");
  const removeItem = vi.spyOn(env.window.Storage.prototype, "removeItem");
  const clear = vi.spyOn(env.window.Storage.prototype, "clear");

  env.loadScripts(["config/terminal-tips.js", "js/terminal-tips-panel.js"]);
  const { initializeTerminalTipsPanel } = env.exportValues([
    "initializeTerminalTipsPanel",
  ]);
  initializeTerminalTipsPanel();

  controls = {
    close: env.document.getElementById("terminal-tips-close"),
    panel: env.document.getElementById("terminal-tips-panel"),
    results: env.document.getElementById("terminal-tips-results"),
    search: env.document.getElementById("terminal-tips-search"),
    status: env.document.getElementById("terminal-tips-status"),
    toggle: env.document.getElementById("terminal-tips-toggle"),
  };

  return { clear, removeItem, setItem, terminalState };
}

function click(element) {
  element.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
}

function enterQuery(value) {
  controls.search.value = value;
  controls.search.dispatchEvent(new env.window.Event("input", { bubbles: true }));
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("Terminal tips panel", () => {
  it("starts hidden and opens with all text tips and search focus", () => {
    setupPanel();

    expect(controls.panel.hidden).toBe(true);
    expect(controls.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(controls.search.value).toBe("");
    expect(controls.status.textContent).toBe("3 tips");

    click(controls.toggle);

    expect(controls.panel.hidden).toBe(false);
    expect(controls.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(controls.search);
    expect(controls.results.textContent).toContain("help: Type help to list commands.");
    expect(controls.results.textContent).toContain("version: Type version to view build identity.");
    expect(controls.results.textContent).toContain("shortcuts: Type man shortcuts to view editing shortcuts.");
    expect(controls.results.querySelectorAll("li")).toHaveLength(3);
  });

  it("filters literally while retaining focus and announces known and unmatched results", () => {
    setupPanel();
    click(controls.toggle);

    enterQuery("  VeRsIoN  ");
    expect(env.document.activeElement).toBe(controls.search);
    expect(controls.status.textContent).toBe("1 matching tip");
    expect(controls.results.textContent).toBe("version: Type version to view build identity.");

    enterQuery(".");
    expect(env.document.activeElement).toBe(controls.search);
    expect(controls.status.textContent).toBe("3 matching tips");

    enterQuery("[");
    expect(env.document.activeElement).toBe(controls.search);
    expect(controls.status.textContent).toBe("0 matching tips");
    expect(controls.results.textContent).toBe("No matching tips.");
  });

  it("uses the same focus-restoring dismissal for Close, toggle-again, and Escape", () => {
    setupPanel();
    click(controls.toggle);
    enterQuery("help");

    click(controls.close);
    expect(controls.panel.hidden).toBe(true);
    expect(controls.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(controls.toggle);

    click(controls.toggle);
    expect(controls.search.value).toBe("help");
    expect(env.document.activeElement).toBe(controls.search);
    click(controls.toggle);
    expect(controls.panel.hidden).toBe(true);
    expect(env.document.activeElement).toBe(controls.toggle);

    click(controls.toggle);
    controls.search.dispatchEvent(
      new env.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(controls.panel.hidden).toBe(true);
    expect(controls.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(controls.toggle);
    expect(controls.search.value).toBe("help");
  });

  it("keeps terminal and preference state untouched through repeated cycles", () => {
    const { clear, removeItem, setItem, terminalState } = setupPanel();
    const terminal = env.document.getElementById("terminal");
    const originalTerminal = terminal;
    const originalText = terminal.textContent;

    click(controls.toggle);
    enterQuery("version");
    click(controls.close);
    expect(terminalState.execute).not.toHaveBeenCalled();
    expect(terminalState.clear).not.toHaveBeenCalled();
    expect(terminalState.open).not.toHaveBeenCalled();
    expect(terminalState.write).not.toHaveBeenCalled();
    expect(terminalState.pendingInput).toBe("echo PEND");
    expect(env.document.getElementById("terminal")).toBe(originalTerminal);
    expect(terminal.textContent).toBe(originalText);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    click(controls.toggle);
    enterQuery("shortcuts");
    controls.search.dispatchEvent(
      new env.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(terminalState.execute).not.toHaveBeenCalled();
    expect(terminalState.clear).not.toHaveBeenCalled();
    expect(terminalState.open).not.toHaveBeenCalled();
    expect(terminalState.write).not.toHaveBeenCalled();
    expect(terminalState.pendingInput).toBe("echo PEND");
    expect(env.document.getElementById("terminal")).toBe(originalTerminal);
    expect(terminal.textContent).toBe(originalText);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });
});
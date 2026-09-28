import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv, REPO_ROOT } from "./helpers/browser-env";

const panelMarkup = fs
  .readFileSync(path.join(REPO_ROOT, "index.html"), "utf8")
  .match(/<button\s+id="terminal-tips-toggle"[\s\S]*?<\/section>/)[0];

let env;
afterEach(() => {
  if (env) env.cleanup();
  env = null;
});

function loadTips(options = {}) {
  const terminal = options.terminal || {
    currentLine: "echo q",
    command: vi.fn(),
    open: vi.fn(),
    reset: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };
  env = createBrowserEnv({
    html: `<!doctype html><html><body>${panelMarkup}<div id="terminal"></div></body></html>`,
    globals: { term: terminal, ...options.globals },
  });
  if (!options.globals?.TerminalTips) env.loadScript("js/terminal-tips-model.js");
  env.window.localStorage.setItem("terminal-preference", "preserved");
  env.loadScript("js/terminal-tips.js");
  return { ...env, terminal };
}

function elements(document) {
  return {
    close: document.querySelector("#terminal-tips-close"),
    panel: document.querySelector("#terminal-tips-panel"),
    results: document.querySelector("#terminal-tips-results"),
    search: document.querySelector("#terminal-tips-search"),
    status: document.querySelector("#terminal-tips-status"),
    toggle: document.querySelector("#terminal-tips-toggle"),
  };
}

describe("Terminal tips panel events", () => {
  it("opens, filters, closes repeatedly, and preserves focus, filter, and terminal state", () => {
    const { document, terminal, window } = loadTips();
    const { close, panel, results, search, status, toggle } = elements(document);

    expect(panel.hidden).toBe(true);
    expect(search.value).toBe("");
    expect(status.textContent).toBe("3 tips");

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search);

    search.value = " VERSION ";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(document.activeElement).toBe(search);
    expect(results.textContent).toContain("type version to view build identity");
    expect(results.textContent).not.toContain("type help to list commands");
    expect(status.textContent).toBe("1 tip");
    expect(terminal.currentLine).toBe("echo q");
    expect(terminal.command).not.toHaveBeenCalled();
    expect(terminal.open).not.toHaveBeenCalled();
    expect(terminal.reset).not.toHaveBeenCalled();
    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.writeln).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("terminal-preference")).toBe("preserved");

    close.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    expect(search.value).toBe(" VERSION ");
    expect(document.activeElement).toBe(search);

    toggle.click();
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    search.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(terminal.currentLine).toBe("echo q");
    expect(terminal.command).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("terminal-preference")).toBe("preserved");
  });

  it("renders unmatched and model-provided values as text without executing markup", () => {
    const malicious = '<img src=x onerror="window.tipsExecuted=true">';
    const filterTips = vi.fn(() => [
      { title: malicious, description: "safe description" },
    ]);
    const { document, window } = loadTips({
      globals: { TerminalTips: { filterTips } },
    });
    const { results, search, status, toggle } = elements(document);

    toggle.click();
    expect(results.textContent).toContain(malicious);
    expect(results.querySelector("img")).toBeNull();
    expect(window.tipsExecuted).toBeUndefined();

    filterTips.mockReturnValue([]);
    search.value = "?";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(results.textContent).toBe("No matching tips");
    expect(status.textContent).toBe("No matching tips");
    expect(document.activeElement).toBe(search);
  });

  it("starts a new document session hidden with an empty filter", () => {
    let loaded = loadTips();
    let controls = elements(loaded.document);
    controls.toggle.click();
    controls.search.value = "help";
    controls.search.dispatchEvent(
      new loaded.window.Event("input", { bubbles: true })
    );
    env.cleanup();
    env = null;

    loaded = loadTips();
    controls = elements(loaded.document);
    expect(controls.panel.hidden).toBe(true);
    expect(controls.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(controls.search.value).toBe("");
    expect(controls.status.textContent).toBe("3 tips");
  });
});
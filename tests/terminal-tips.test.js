import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";
import buildPagesModule from "../scripts/build-pages.js";
import buildAssetsModule from "../scripts/build-assets.js";

const panelMarkup = `
  <button id="terminal-tips-toggle" aria-controls="terminal-tips-panel" aria-expanded="false">Terminal tips</button>
  <section id="terminal-tips-panel" role="region" aria-labelledby="terminal-tips-heading" hidden>
    <h2 id="terminal-tips-heading">Terminal tips</h2>
    <button id="terminal-tips-close">Close</button>
    <label for="terminal-tips-search">Search terminal tips</label>
    <input id="terminal-tips-search" type="search">
    <p id="terminal-tips-status" role="status" aria-live="polite"></p>
    <div id="terminal-tips-results"></div>
  </section>
  <div id="terminal"></div>
`;

let env;

function loadTips() {
  env = createBrowserEnv({ html: `<!doctype html><body>${panelMarkup}</body>` });
  env.loadScripts(["js/terminal-tips-model.js", "js/terminal-tips.js"]);
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

function input(element, value) {
  element.value = value;
  element.dispatchEvent(new env.window.Event("input", { bubbles: true }));
}

afterEach(() => {
  env?.cleanup();
  env = null;
});

describe("terminal tips panel", () => {
  it("starts hidden with the complete text-rendered catalog and empty filter", () => {
    const state = loadTips();

    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(state.search.value).toBe("");
    expect(state.results.textContent).toContain("help");
    expect(state.results.textContent).toContain("type help to list commands");
    expect(state.results.textContent).toContain("version");
    expect(state.results.textContent).toContain("shortcuts");
    expect(state.results.children).toHaveLength(3);
    expect(state.status.textContent).toBe("3 tips shown");
    expect(state.results.querySelector("script")).toBeNull();
  });

  it("opens with search focus and filters literally without moving focus", () => {
    const state = loadTips();
    state.toggle.click();

    expect(state.panel.hidden).toBe(false);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(state.search);

    input(state.search, "  VIEW BUILD  ");
    expect(env.document.activeElement).toBe(state.search);
    expect(state.results.textContent).toContain("type version to view build identity");
    expect(state.results.textContent).not.toContain("type help to list commands");
    expect(state.status.textContent).toBe("1 tip shown");

    input(state.search, "[");
    expect(state.results.textContent).toBe("No matching tips");
    expect(state.status.textContent).toBe("0 tips shown");
  });

  it.each([
    ["toggle", (state) => state.toggle.click()],
    ["Close", (state) => state.close.click()],
    ["Escape", (state) => state.search.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))],
  ])("restores opener focus after %s dismissal", (_label, dismiss) => {
    const state = loadTips();
    state.toggle.click();
    dismiss(state);

    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(state.toggle);
  });

  it("preserves the raw query through repeated page-session cycles", () => {
    const state = loadTips();
    state.toggle.click();
    input(state.search, "  VeRsIoN  ");
    state.close.click();
    state.toggle.click();

    expect(state.search.value).toBe("  VeRsIoN  ");
    expect(state.results.textContent).toContain("type version to view build identity");
    expect(env.document.activeElement).toBe(state.search);

    state.toggle.click();
    state.toggle.click();
    expect(state.search.value).toBe("  VeRsIoN  ");
  });

  it("does not touch terminal state, handlers, or persistent storage", () => {
    const state = loadTips();
    const terminalKeydown = vi.fn();
    const initialTerminal = state.terminal;
    state.terminal.textContent = "echo z\necho q";
    state.terminal.addEventListener("keydown", terminalKeydown);
    const storageGet = vi.spyOn(env.window.localStorage, "getItem");
    const storageSet = vi.spyOn(env.window.localStorage, "setItem");
    const storageRemove = vi.spyOn(env.window.localStorage, "removeItem");
    const storageClear = vi.spyOn(env.window.localStorage, "clear");

    state.toggle.click();
    input(state.search, "shortcuts");
    state.close.click();
    state.toggle.click();
    state.search.dispatchEvent(new env.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(env.document.getElementById("terminal")).toBe(initialTerminal);
    expect(state.terminal.textContent).toBe("echo z\necho q");
    expect(terminalKeydown).not.toHaveBeenCalled();
    expect(storageGet).not.toHaveBeenCalled();
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
    expect(storageClear).not.toHaveBeenCalled();
  });

  it("a fresh document resets the panel and raw filter", () => {
    let state = loadTips();
    state.toggle.click();
    input(state.search, "version");
    env.cleanup();
    env = null;

    state = loadTips();
    expect(state.panel.hidden).toBe(true);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(state.search.value).toBe("");
    expect(state.status.textContent).toBe("3 tips shown");
  });
});

describe("terminal tips integration", () => {
  it("ships accessible controls outside the terminal and ordered bundle sources", () => {
    const html = buildPagesModule.renderIndexHtml(buildPagesModule.loadConfig());
    const page = createBrowserEnv({ html });
    const terminal = page.document.getElementById("terminal");
    const toggle = page.document.getElementById("terminal-tips-toggle");
    const panel = page.document.getElementById("terminal-tips-panel");

    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.textContent.trim()).toBe("Terminal tips");
    expect(terminal.contains(toggle)).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute("role")).toBe("region");
    expect(page.document.querySelector('label[for="terminal-tips-search"]')).not.toBeNull();
    expect(page.document.getElementById("terminal-tips-search").type).toBe("search");
    expect(page.document.getElementById("terminal-tips-status").getAttribute("aria-live")).toBe("polite");
    expect(page.document.getElementById("terminal-tips-close").tagName).toBe("BUTTON");
    page.cleanup();

    const { appBundleSources } = buildAssetsModule;
    expect(appBundleSources.indexOf("js/terminal-tips-model.js")).toBeLessThan(
      appBundleSources.indexOf("js/terminal-tips.js")
    );
    expect(appBundleSources.indexOf("js/terminal-tips.js")).toBeLessThan(
      appBundleSources.indexOf("js/bootstrap.js")
    );
  });
});
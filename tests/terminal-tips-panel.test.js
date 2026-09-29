import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

const panelMarkup = `
  <!doctype html>
  <html>
    <body>
      <button
        id="terminal-tips-toggle"
        type="button"
        aria-controls="terminal-tips-panel"
        aria-expanded="false"
      >Terminal tips</button>
      <section
        id="terminal-tips-panel"
        role="region"
        aria-labelledby="terminal-tips-heading"
        hidden
      >
        <h2 id="terminal-tips-heading">Terminal tips</h2>
        <button id="terminal-tips-close" type="button">Close</button>
        <label for="terminal-tips-search">Filter terminal tips</label>
        <input id="terminal-tips-search" type="search" />
        <div id="terminal-tips-results"></div>
        <p id="terminal-tips-status" role="status" aria-live="polite"></p>
      </section>
      <div id="terminal">unchanged output</div>
    </body>
  </html>
`;

function loadPanel() {
  env = createBrowserEnv({ html: panelMarkup });
  env.loadScripts(["js/terminal-tips.js", "js/terminal-tips-panel.js"]);
  const { setupTerminalTipsPanel } = env.exportValues([
    "setupTerminalTipsPanel",
  ]);
  setupTerminalTipsPanel();

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

function expectClosed(state) {
  expect(state.panel.hidden).toBe(true);
  expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
  expect(env.document.activeElement).toBe(state.toggle);
}

function expectTerminalUntouched(state, terminalState, storageSpies) {
  expect(state.terminal.textContent).toBe("unchanged output");
  expect(terminalState).toEqual({
    currentLine: "echo q",
    history: ["echo z"],
    dispatches: 0,
    initializations: 1,
  });
  expect(storageSpies.local).not.toHaveBeenCalled();
  expect(storageSpies.session).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal tips panel", () => {
  it("starts hidden and renders the exact textual tips when opened", () => {
    const state = loadPanel();

    expect(state.panel.hidden).toBe(true);
    expect(state.search.value).toBe("");
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");

    state.toggle.click();

    expect(state.panel.hidden).toBe(false);
    expect(state.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(state.search);
    expect(
      [...state.results.querySelectorAll("[data-tip-id]")].map((item) => ({
        id: item.dataset.tipId,
        text: item.textContent,
      }))
    ).toEqual([
      { id: "help", text: "help — type help to list commands" },
      { id: "version", text: "version — type version to view build identity" },
      {
        id: "shortcuts",
        text: "shortcuts — type man shortcuts to view editing shortcuts",
      },
    ]);
    expect(state.results.querySelectorAll("script")).toHaveLength(0);
    expect(state.status.textContent).toBe("3 tips shown");
  });

  it("filters literally while preserving search focus and reports no matches", () => {
    const state = loadPanel();
    state.toggle.click();

    input(state.search, "  BuIlD  ");

    expect(env.document.activeElement).toBe(state.search);
    expect(state.results.querySelectorAll("[data-tip-id]")).toHaveLength(1);
    expect(state.results.textContent).toContain(
      "version — type version to view build identity"
    );
    expect(state.status.textContent).toBe("1 tip shown");

    input(state.search, "does.not.exist");

    expect(env.document.activeElement).toBe(state.search);
    expect(state.results.textContent).toBe("No matching tips");
    expect(state.status.textContent).toBe("No matching tips");
  });

  it("uses one focus-restoring close outcome for Close, toggle, and panel Escape", () => {
    const state = loadPanel();

    state.toggle.click();
    state.close.click();
    expectClosed(state);

    state.toggle.click();
    state.toggle.click();
    expectClosed(state);

    state.toggle.click();
    const escape = new env.window.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    state.search.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expectClosed(state);
  });

  it("preserves the query through repeated cycles and resets in a fresh document", () => {
    let state = loadPanel();
    state.toggle.click();
    input(state.search, "  HELP  ");
    state.close.click();
    state.toggle.click();

    expect(state.search.value).toBe("  HELP  ");
    expect(state.results.querySelector("[data-tip-id='help']")).not.toBeNull();
    expect(state.status.textContent).toBe("1 tip shown");

    state.toggle.click();
    state.toggle.click();
    expect(state.search.value).toBe("  HELP  ");

    env.cleanup();
    env = null;
    state = loadPanel();

    expect(state.panel.hidden).toBe(true);
    expect(state.search.value).toBe("");
    expect(state.toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("never mutates terminal state, dispatches commands, clears output, reinitializes, or writes storage", () => {
    const terminalState = {
      currentLine: "echo q",
      history: ["echo z"],
      dispatches: 0,
      initializations: 1,
    };
    const state = loadPanel();
    env.window.term = terminalState;
    const storageSpies = {
      local: vi.spyOn(env.window.localStorage, "setItem"),
      session: vi.spyOn(env.window.sessionStorage, "setItem"),
    };

    state.toggle.click();
    expectTerminalUntouched(state, terminalState, storageSpies);

    input(state.search, "build");
    expectTerminalUntouched(state, terminalState, storageSpies);

    state.close.click();
    expectTerminalUntouched(state, terminalState, storageSpies);

    state.toggle.click();
    state.toggle.click();
    expectTerminalUntouched(state, terminalState, storageSpies);

    state.toggle.click();
    state.search.dispatchEvent(
      new env.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expectTerminalUntouched(state, terminalState, storageSpies);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const baseGlobals = {
  _DIRS: { "~": [] },
  _filesHere: () => [],
  commands: { help: () => {} },
  portfolio: {},
  team: {},
};

let env;

function loadTerminalScript(globals = {}) {
  env = createBrowserEnv({
    globals: {
      ...baseGlobals,
      ...globals,
    },
  });
  env.loadScripts(["js/terminal.js"]);
  return env.exportValues(["runRootTerminal"]);
}

function createTerm(overrides = {}) {
  const term = {
    _initialized: false,
    busy: false,
    attachCustomKeyEventHandler: vi.fn((handler) => {
      term._customKeyHandler = handler;
    }),
    clearCurrentLine: vi.fn(),
    currentLine: "",
    executeCommandLine: vi.fn(),
    history: [],
    historyCursor: -1,
    init: vi.fn(),
    locked: false,
    pos: vi.fn(() => 0),
    prompt: vi.fn(),
    resizeListener: vi.fn(),
    runDeepLink: vi.fn(),
    scrollToBottom: vi.fn(),
    setCurrentLine: vi.fn((line) => {
      term.currentLine = line;
    }),
    tabBase: "",
    tabIndex: 0,
    tabOptions: [],
    write: vi.fn(),
  };

  term.onData = vi.fn((handler) => {
    term._onData = handler;
    return { dispose: vi.fn() };
  });

  return Object.assign(term, overrides);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("runRootTerminal", () => {
  it("initializes once and prompts immediately", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm();

    runRootTerminal(term);

    expect(term.init).toHaveBeenCalledTimes(1);
    expect(term.prompt).toHaveBeenCalledTimes(1);
    expect(term.runDeepLink).toHaveBeenCalledTimes(1);
    expect(term.onData).toHaveBeenCalledTimes(1);
    expect(term._initialized).toBe(true);
  });

  it("sends the current line through executeCommandLine on Enter", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({
      currentLine: "help",
      tabBase: "hel",
      tabIndex: 2,
      tabOptions: ["help"],
    });

  it.each([
    ["Alt+Left", { altKey: true, key: "ArrowLeft" }, 11, "one   two", 6],
    ["Alt+Right", { altKey: true, key: "ArrowRight" }, 0, "one   two", 6],
    ["Ctrl+W", { ctrlKey: true, key: "w" }, 9, "one   two! end", 6, "one   end"],
    ["Alt+D", { altKey: true, key: "d" }, 3, "one   two! end", 3, "oneend"],
    ["Ctrl+A", { ctrlKey: true, key: "a" }, 7, "one two", 0],
    ["Ctrl+E", { ctrlKey: true, key: "e" }, 0, "one two", 7],
    ["Ctrl+U", { ctrlKey: true, key: "u" }, 4, "one two", 0, ""],
  ])("handles %s without submitting", (_name, chord, start, line, end, result = line) => {
    const { runRootTerminal } = loadTerminalScript();
    let cursor = start;
    const term = createTerm({ currentLine: line, pos: vi.fn(() => cursor) });
    term.write = vi.fn((output) => {
      for (const match of output.matchAll(/\x1b\[([CD])/g)) {
        cursor += match[1] === "C" ? 1 : -1;
      }
      if (!output.startsWith("\x1b[")) {
        cursor = output.replace(/\x1b\[K$/, "").length;
      }
    });
    const preventDefault = vi.fn();

    runRootTerminal(term);
    const handled = term._customKeyHandler({
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      type: "keydown",
      preventDefault,
      ...chord,
    });

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(term.currentLine).toBe(result);
    expect(cursor).toBe(end);
    expect(term.executeCommandLine).not.toHaveBeenCalled();
    expect(term.prompt).toHaveBeenCalledTimes(1);
    expect(term.runDeepLink).toHaveBeenCalledTimes(1);
  });

  it("leaves empty input unchanged and passes near-miss modifiers through", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm();
    runRootTerminal(term);

    for (const chord of [
      { altKey: true, key: "ArrowLeft" },
      { ctrlKey: true, key: "w" },
      { altKey: true, key: "d" },
      { ctrlKey: true, key: "a" },
      { ctrlKey: true, key: "e" },
      { ctrlKey: true, key: "u" },
    ]) {
      const preventDefault = vi.fn();
      expect(term._customKeyHandler({
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        type: "keydown",
        preventDefault,
        ...chord,
      })).toBe(false);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(term.currentLine).toBe("");
      expect(term.executeCommandLine).not.toHaveBeenCalled();
      expect(term.write).not.toHaveBeenCalled();
    }

    for (const chord of [
      { altKey: true, key: "ArrowLeft", shiftKey: true },
      { altKey: true, ctrlKey: true, key: "d" },
      { ctrlKey: true, key: "w", metaKey: true },
      { altKey: false, ctrlKey: false, key: "a" },
    ]) {
      expect(term._customKeyHandler({
        metaKey: false,
        shiftKey: false,
        type: "keydown",
        ...chord,
      })).toBe(true);
    }
  });

    runRootTerminal(term);
    term._onData("\r");

    expect(term.executeCommandLine).toHaveBeenCalledWith("help");
    expect(term.tabBase).toBe("");
    expect(term.tabIndex).toBe(0);
    expect(term.tabOptions).toEqual([]);
    expect(term.scrollToBottom).toHaveBeenCalled();
  });

  it("debounces resize handling with requestAnimationFrame", () => {
    const rafCallbacks = [];
    const requestAnimationFrame = vi.fn((callback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    const { runRootTerminal } = loadTerminalScript({ requestAnimationFrame });
    const term = createTerm();

    runRootTerminal(term);
    env.window.dispatchEvent(new env.window.Event("resize"));
    env.window.dispatchEvent(new env.window.Event("resize"));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(term.resizeListener).not.toHaveBeenCalled();

    rafCallbacks[0]();

    expect(term.resizeListener).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the terminal is already initialized", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({ _initialized: true });

    runRootTerminal(term);

    expect(term.init).not.toHaveBeenCalled();
    expect(term.prompt).not.toHaveBeenCalled();
    expect(term.onData).not.toHaveBeenCalled();
  });
});

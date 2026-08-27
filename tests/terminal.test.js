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

  it("recalls history from newest to oldest without wrapping", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({ history: ["first", "second"] });

    runRootTerminal(term);
    term._onData("\x1b[A");
    term._onData("\x1b[A");
    term._onData("\x1b[A");

    expect(term.setCurrentLine).toHaveBeenNthCalledWith(1, "second", false);
    expect(term.setCurrentLine).toHaveBeenNthCalledWith(2, "first", false);
    expect(term.setCurrentLine).toHaveBeenCalledTimes(2);
  });

  it("moves forward through history and clears past newest without wrapping", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({ history: ["first", "second"] });

    runRootTerminal(term);
    term._onData("\x1b[A");
    term._onData("\x1b[A");
    term._onData("\x1b[A");
    term._onData("\x1b[B");
    term._onData("\x1b[B");
    term._onData("\x1b[B");

    expect(term.setCurrentLine).toHaveBeenNthCalledWith(3, "second", false);
    expect(term.clearCurrentLine).toHaveBeenNthCalledWith(1, true);
    expect(term.clearCurrentLine).toHaveBeenNthCalledWith(2, true);
  });

  it("resets the cursor after clearing past newest so Up recalls newest", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({ history: ["first", "second"] });
    term.clearCurrentLine = vi.fn(() => {
      term.currentLine = "";
    });

    runRootTerminal(term);
    term._onData("\x1b[A");
    term._onData("\x1b[A");
    term._onData("\x1b[B");
    term._onData("\x1b[B");

    expect(term.currentLine).toBe("");
    expect(term.historyCursor).toBe(-1);

    term._onData("\x1b[A");

    expect(term.setCurrentLine).toHaveBeenNthCalledWith(3, "second", false);
    expect(term.currentLine).toBe("second");
  });

  it("leaves an empty history unchanged when arrow keys are pressed", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({ currentLine: "typed" });

    runRootTerminal(term);
    term._onData("\x1b[A");
    term._onData("\x1b[B");

    expect(term.setCurrentLine).not.toHaveBeenCalled();
    expect(term.executeCommandLine).not.toHaveBeenCalled();
    expect(term.currentLine).toBe("typed");
  });
});

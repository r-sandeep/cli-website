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

  term.attachCustomKeyEventHandler = vi.fn((handler) => {
    term._customKeyHandler = handler;
  });
  term.onData = vi.fn((handler) => {
    term._onData = handler;
    return { dispose: vi.fn() };
  });

  return Object.assign(term, overrides);
}

function keyEvent(chord, preventDefault = vi.fn()) {
  return {
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    type: "keydown",
    preventDefault,
    ...chord,
  };
}

function createEditingTerm({ line = "", cursor = line.length, history = [] } = {}) {
  let visualCursor = cursor;
  const term = createTerm({
    currentLine: line,
    history: [...history],
    pos: vi.fn(() => visualCursor),
  });

  term.write = vi.fn((output) => {
    for (const token of output.matchAll(/\x1b\[([CDK])|([\s\S])/g)) {
      if (token[1] === "C") visualCursor++;
      else if (token[1] === "D") visualCursor--;
      else if (!token[1]) visualCursor++;
    }
  });
  term.clearCurrentLine = vi.fn((goToEndOfHistory = false) => {
    term.currentLine = "";
    visualCursor = 0;
    if (goToEndOfHistory) term.historyCursor = -1;
  });
  term.setCurrentLine = vi.fn((newLine, preserveCursor = false) => {
    const oldLength = term.currentLine.length;
    const oldCursor = visualCursor;
    term.currentLine = newLine;
    visualCursor = preserveCursor
      ? Math.max(0, newLine.length - (oldLength - oldCursor))
      : newLine.length;
  });

  return { term, cursor: () => visualCursor };
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
    expect(term.attachCustomKeyEventHandler).toHaveBeenCalledTimes(1);
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

  it.each([
    ["Alt+Left", { altKey: true, key: "ArrowLeft" }, 9, "one   two", 6, "one   two"],
    ["Alt+Right", { altKey: true, key: "ArrowRight" }, 0, "one   two", 6, "one   two"],
    ["Ctrl+W", { ctrlKey: true, key: "w" }, 11, "one   two! end", 6, "one   end"],
    ["Alt+D", { altKey: true, key: "d" }, 6, "one   two! end", 6, "one   end"],
    ["Ctrl+A", { ctrlKey: true, key: "a" }, 7, "one two", 0, "one two"],
    ["Ctrl+E", { ctrlKey: true, key: "e" }, 0, "one two", 7, "one two"],
    ["Ctrl+U", { ctrlKey: true, key: "u" }, 4, "one two", 0, ""],
  ])("handles %s without submitting", (_name, chord, start, line, end, result) => {
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
    const handled = term._customKeyHandler(keyEvent(chord, preventDefault));

    expect(handled).toBe(false);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(term.currentLine).toBe(result);
    expect(cursor).toBe(end);
    expect(term.executeCommandLine).not.toHaveBeenCalled();
    expect(term.prompt).toHaveBeenCalledTimes(1);
    expect(term.runDeepLink).toHaveBeenCalledTimes(1);
  });

  it("keeps all shortcuts harmless on empty input", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm();
    runRootTerminal(term);

    for (const chord of [
      { altKey: true, key: "ArrowLeft" },
      { altKey: true, key: "ArrowRight" },
      { ctrlKey: true, key: "w" },
      { altKey: true, key: "d" },
      { ctrlKey: true, key: "a" },
      { ctrlKey: true, key: "e" },
      { ctrlKey: true, key: "u" },
    ]) {
      const preventDefault = vi.fn();
      expect(term._customKeyHandler(keyEvent(chord, preventDefault))).toBe(false);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(term.currentLine).toBe("");
      expect(term.executeCommandLine).not.toHaveBeenCalled();
      expect(term.write).not.toHaveBeenCalled();
    }
  });

  it("passes modifier near misses and unrelated keys through unchanged", () => {
    const { runRootTerminal } = loadTerminalScript();
    const term = createTerm({ currentLine: "one two", pos: vi.fn(() => 4) });
    runRootTerminal(term);

    for (const chord of [
      { altKey: true, key: "ArrowLeft", shiftKey: true },
      { altKey: true, ctrlKey: true, key: "d" },
      { ctrlKey: true, key: "w", metaKey: true },
      { altKey: false, ctrlKey: false, key: "a" },
      { altKey: true, key: "x" },
    ]) {
      expect(term._customKeyHandler(keyEvent(chord))).toBe(true);
      expect(term.currentLine).toBe("one two");
      expect(term.write).not.toHaveBeenCalled();
      expect(term.executeCommandLine).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["Alt+Left crosses an all-space line", { altKey: true, key: "ArrowLeft" }, "   ", 3, "   ", 0],
    ["Alt+Right crosses an all-space line", { altKey: true, key: "ArrowRight" }, "   ", 0, "   ", 3],
    ["Alt+Left stops after leading spaces", { altKey: true, key: "ArrowLeft" }, "   word", 7, "   word", 3],
    ["Alt+Right crosses trailing spaces", { altKey: true, key: "ArrowRight" }, "word   ", 0, "word   ", 7],
    ["Alt+Right keeps punctuation in its word", { altKey: true, key: "ArrowRight" }, "one.two   next", 0, "one.two   next", 10],
    ["Alt+Left keeps punctuation in its word", { altKey: true, key: "ArrowLeft" }, "one.two   next", 7, "one.two   next", 0],
    ["Alt+Left stays at zero", { altKey: true, key: "ArrowLeft" }, "one", 0, "one", 0],
    ["Alt+Right stays at line length", { altKey: true, key: "ArrowRight" }, "one", 3, "one", 3],
    ["Ctrl+W removes all preceding spaces", { ctrlKey: true, key: "w" }, "   ", 3, "", 0],
    ["Alt+D removes only leading spaces", { altKey: true, key: "d" }, "   word", 0, "word", 0],
    ["Ctrl+W crosses trailing spaces and the word", { ctrlKey: true, key: "w" }, "word   ", 7, "", 0],
    ["Alt+D treats punctuation as word content", { altKey: true, key: "d" }, "one.two   next", 0, "next", 0],
    ["Ctrl+A stays at zero", { ctrlKey: true, key: "a" }, "one", 0, "one", 0],
    ["Ctrl+E stays at line length", { ctrlKey: true, key: "e" }, "one", 3, "one", 3],
    ["Ctrl+U clears an all-space line", { ctrlKey: true, key: "u" }, "   ", 1, "", 0],
  ])("handles boundary case: %s", (_name, chord, line, start, result, end) => {
    const { runRootTerminal } = loadTerminalScript();
    const editing = createEditingTerm({ line, cursor: start });

    runRootTerminal(editing.term);
    const preventDefault = vi.fn();
    expect(editing.term._customKeyHandler(keyEvent(chord, preventDefault))).toBe(false);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(editing.term.currentLine).toBe(result);
    expect(editing.cursor()).toBe(end);
    expect(editing.term.executeCommandLine).not.toHaveBeenCalled();
  });

  it("suppresses every empty-input shortcut without any terminal or page side effect", () => {
    const open = vi.fn();
    const { runRootTerminal } = loadTerminalScript({ open });
    const editing = createEditingTerm();
    const { term } = editing;
    runRootTerminal(term);
    const initialURL = env.window.location.href;

    for (const chord of [
      { altKey: true, key: "ArrowLeft" },
      { altKey: true, key: "ArrowRight" },
      { ctrlKey: true, key: "w" },
      { altKey: true, key: "d" },
      { ctrlKey: true, key: "a" },
      { ctrlKey: true, key: "e" },
      { ctrlKey: true, key: "u" },
    ]) {
      const preventDefault = vi.fn();
      const writesBefore = term.write.mock.calls.length;
      const promptsBefore = term.prompt.mock.calls.length;
      const deepLinksBefore = term.runDeepLink.mock.calls.length;

      expect(term._customKeyHandler(keyEvent(chord, preventDefault))).toBe(false);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(term.currentLine).toBe("");
      expect(editing.cursor()).toBe(0);
      expect(term.write).toHaveBeenCalledTimes(writesBefore);
      expect(term.prompt).toHaveBeenCalledTimes(promptsBefore);
      expect(term.runDeepLink).toHaveBeenCalledTimes(deepLinksBefore);
      expect(term.executeCommandLine).not.toHaveBeenCalled();
      expect(term.clearCurrentLine).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(env.window.location.href).toBe(initialURL);
    }
  });

  it("composes word actions with ordinary arrows and printable insertion", () => {
    const { runRootTerminal } = loadTerminalScript();
    const editing = createEditingTerm({ line: "alpha   beta.gamma  delta" });
    const { term } = editing;
    runRootTerminal(term);

    term._customKeyHandler(keyEvent({ altKey: true, key: "ArrowLeft" }));
    expect(editing.cursor()).toBe(20);
    term._onData("\x1b[D");
    expect(editing.cursor()).toBe(19);
    term._customKeyHandler(keyEvent({ altKey: true, key: "d" }));
    expect(term.currentLine).toBe("alpha   beta.gamma delta");
    expect(editing.cursor()).toBe(19);
    term._onData("\x1b[C");
    expect(editing.cursor()).toBe(20);
    term._customKeyHandler(keyEvent({ altKey: true, key: "ArrowLeft" }));
    expect(editing.cursor()).toBe(19);
    term._onData("X");
    expect(term.currentLine).toBe("alpha   beta.gamma Xdelta");
    expect(editing.cursor()).toBe(20);
    term._onData("\x1b[D");
    expect(editing.cursor()).toBe(19);
    term._customKeyHandler(keyEvent({ altKey: true, key: "ArrowRight" }));
    expect(editing.cursor()).toBe(term.currentLine.length);
    expect(term.executeCommandLine).not.toHaveBeenCalled();
  });

  it("preserves history ordering and the post-newest sentinel while editing a recall", () => {
    const { runRootTerminal } = loadTerminalScript();
    const history = ["oldest command", "newest   command"];
    const editing = createEditingTerm({ history });
    const { term } = editing;
    runRootTerminal(term);

    term._onData("\x1b[A");
    expect([term.currentLine, term.historyCursor]).toEqual(["newest   command", 0]);
    term._onData("\x1b[A");
    expect([term.currentLine, term.historyCursor]).toEqual(["oldest command", 1]);
    term._onData("\x1b[B");
    expect([term.currentLine, term.historyCursor]).toEqual(["newest   command", 0]);
    term._onData("\x1b[B");
    expect([term.currentLine, term.historyCursor]).toEqual(["", -1]);
    term._onData("\x1b[A");
    expect([term.currentLine, term.historyCursor]).toEqual(["newest   command", 0]);

    term._customKeyHandler(keyEvent({ altKey: true, key: "ArrowLeft" }));
    term._onData("\x1b[D");
    term._customKeyHandler(keyEvent({ altKey: true, key: "d" }));
    term._onData("\x1b[C");
    term._customKeyHandler(keyEvent({ ctrlKey: true, key: "w" }));
    term._onData("X");
    expect(term.currentLine).toBe("newest  Xommand");
    expect(editing.cursor()).toBe(9);
    expect(term.history).toEqual(history);
    expect(term.historyCursor).toBe(0);

    term._onData("\x1b[B");
    expect([term.currentLine, term.historyCursor]).toEqual(["", -1]);
    term._onData("\x1b[A");
    expect([term.currentLine, term.historyCursor]).toEqual(["newest   command", 0]);
    expect(term.history).toEqual(history);
  });

  it("passes near misses to the existing data path without inserting shortcut bytes", () => {
    const { runRootTerminal } = loadTerminalScript();
    const editing = createEditingTerm({ line: "ac", cursor: 1 });
    const { term } = editing;
    runRootTerminal(term);

    for (const chord of [
      { altKey: true, key: "ArrowRight", shiftKey: true },
      { ctrlKey: true, key: "u", shiftKey: true },
      { altKey: true, ctrlKey: true, key: "ArrowLeft" },
      { altKey: true, key: "d", metaKey: true },
      { ctrlKey: true, key: "e", type: "keyup" },
    ]) {
      const writesBefore = term.write.mock.calls.length;
      expect(term._customKeyHandler(keyEvent(chord))).toBe(true);
      expect(term.currentLine).toBe("ac");
      expect(editing.cursor()).toBe(1);
      expect(term.write).toHaveBeenCalledTimes(writesBefore);
    }

    term._onData("b");
    expect(term.currentLine).toBe("abc");
    expect(editing.cursor()).toBe(2);
    term._customKeyHandler(keyEvent({ altKey: true, key: "ArrowRight" }));
    expect(term.currentLine).toBe("abc");
    expect(term.currentLine).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(term.executeCommandLine).not.toHaveBeenCalled();
  });

  it("redraws middle deletion and complete clearing without disturbing the prompt", () => {
    const { runRootTerminal } = loadTerminalScript();
    const editing = createEditingTerm({ line: "keep remove tail", cursor: 11 });
    const { term } = editing;
    runRootTerminal(term);
    term.write.mockClear();

    term._customKeyHandler(keyEvent({ ctrlKey: true, key: "w" }));
    expect(term.currentLine).toBe("keep  tail");
    expect(editing.cursor()).toBe(5);
    expect(term.write.mock.calls.map(([output]) => output)).toEqual([
      "\x1b[D".repeat(11),
      "keep  tail\x1b[K",
      "\x1b[D".repeat(5),
    ]);
    expect(term.prompt).toHaveBeenCalledTimes(1);

    term.write.mockClear();
    term._customKeyHandler(keyEvent({ ctrlKey: true, key: "u" }));
    expect(term.currentLine).toBe("");
    expect(editing.cursor()).toBe(0);
    expect(term.write.mock.calls.map(([output]) => output)).toEqual([
      "\x1b[D".repeat(5),
      "\x1b[K",
    ]);
    expect(term.prompt).toHaveBeenCalledTimes(1);
    expect(term.clearCurrentLine).not.toHaveBeenCalled();
    expect(term.executeCommandLine).not.toHaveBeenCalled();
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

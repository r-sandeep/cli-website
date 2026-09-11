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

function createInteractiveTerminal() {
  let dataHandler;
  let lines = [""];
  const term = {
    VERSION: 4,
    _core: { buffer: { x: 0 } },
    clear: vi.fn(() => {
      lines = [lines[lines.length - 1]];
    }),
    cols: 80,
    focus: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn((handler) => {
      dataHandler = handler;
      return { dispose: vi.fn() };
    }),
    open: vi.fn(),
    reset: vi.fn(() => {
      lines = [""];
      term._core.buffer.x = 0;
    }),
    scrollToBottom: vi.fn(),
    write: vi.fn((text) => {
      for (let i = 0; i < text.length; ) {
        if (text.startsWith("\x1b[2K\r", i)) {
          lines[lines.length - 1] = "";
          term._core.buffer.x = 0;
          i += 5;
        } else if (text.startsWith("\r\n", i)) {
          lines.push("");
          term._core.buffer.x = 0;
          i += 2;
        } else if (text.startsWith("\x1b[D", i)) {
          term._core.buffer.x = Math.max(0, term._core.buffer.x - 1);
          i += 3;
        } else {
          lines[lines.length - 1] += text[i];
          term._core.buffer.x += 1;
          i += 1;
        }
      }
    }),
  };
  term.writeln = vi.fn((text = "") => term.write(`${text}\r\n`));

  return {
    lines: () => [...lines],
    send: async (data) => {
      await dataHandler(data);
    },
    term,
  };
}

function loadInteractiveTerminal() {
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      colorText: (text) => text,
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      firm: { blurb: "", email: "hello@example.com" },
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      help: {},
      jobs: {},
      portfolio: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      team: {},
    },
  });
  env.loadScripts([
    "js/terminal-ext.js",
    "config/commands.js",
    "js/terminal.js",
  ]);
  const { extend, runRootTerminal } = env.exportValues([
    "extend",
    "runRootTerminal",
  ]);
  const interactive = createInteractiveTerminal();
  extend(interactive.term);
  runRootTerminal(interactive.term);
  return interactive;
}

async function typeCommand(interactive, command) {
  for (const character of command) {
    await interactive.send(character);
  }
  await interactive.send("\r");
}

describe("clear command interaction", () => {
  it("clears prior output and accepts an unknown command at the remaining prompt", async () => {
    const interactive = loadInteractiveTerminal();

    await typeCommand(interactive, "echo prior output");
    expect(interactive.lines().join("\n")).toContain("prior output");

    await typeCommand(interactive, "clear");
    const afterClear = interactive.lines().filter(Boolean);
    expect(afterClear).toEqual(["guest:rootpc ~ $ "]);
    expect(afterClear.join("\n")).not.toContain("prior output");
    expect(afterClear.join("\n")).not.toContain("clear");

    await typeCommand(interactive, "not-a-command");
    const afterUnknown = interactive.lines().join("\n");
    expect(afterUnknown).toContain(
      "Command not found: not-a-command. Try 'help' to get started."
    );
    expect(
      interactive.lines().filter((line) => line === "guest:rootpc ~ $ ")
    ).toHaveLength(1);

  });

  it("retains bounded history through repeated and recalled clear commands", async () => {
    const interactive = loadInteractiveTerminal();

    await typeCommand(interactive, "echo retained");
    await typeCommand(interactive, "clear");
    await interactive.send("\033[A");
    expect(interactive.term.currentLine).toBe("clear");
    await interactive.send("\033[A");
    expect(interactive.term.currentLine).toBe("echo retained");
    await interactive.send("\033[B");
    expect(interactive.term.currentLine).toBe("clear");
    await interactive.send("\033[B");
    expect(interactive.term.currentLine).toBe("");
    await interactive.send("\033[A");
    expect(interactive.term.currentLine).toBe("clear");
    await interactive.send("\r");

    expect(interactive.term.clear).toHaveBeenCalledTimes(2);
    expect(interactive.term.history).toEqual([
      "echo retained",
      "clear",
      "clear",
    ]);
    expect(interactive.lines().filter(Boolean)).toEqual([
      "guest:rootpc ~ $ ",
    ]);

    await typeCommand(interactive, "not-a-command");
    expect(interactive.lines().join("\n")).not.toContain("retained");
    expect(interactive.lines().join("\n")).toContain(
      "Command not found: not-a-command. Try 'help' to get started."
    );

  });
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
});

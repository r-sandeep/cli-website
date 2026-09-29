import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

function createSharedStorage() {
  const values = new Map();
  return {
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key) => (values.has(key) ? values.get(key) : null)),
    key: vi.fn((index) => [...values.keys()][index] ?? null),
    removeItem: vi.fn((key) => values.delete(key)),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    get length() {
      return values.size;
    },
  };
}

function createTerm(cwd = "~") {
  const term = {
    VERSION: 4,
    _initialized: false,
    // The word-wise editing shortcuts (main) register a custom key handler on
    // startup; capture it like tests/terminal.test.js does.
    attachCustomKeyEventHandler: vi.fn((handler) => {
      term._customKeyHandler = handler;
    }),
    buffer: { active: { cursorX: 0 } },
    clear: vi.fn(),
    closePrompt: vi.fn(),
    currentLine: "",
    cwd,
    focus: vi.fn(),
    history: [],
    loadAddon: vi.fn(),
    locked: false,
    onData: vi.fn((handler) => {
      term.input = handler;
    }),
    prompt: vi.fn(),
    promptLength: 0,
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    stylePrint: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };
  return term;
}

function createTerminalEnvironment(storage, cwd = "~", storageGetter) {
  const env = createBrowserEnv({
    url: "https://root.vc/terminal?bookmark-test=1",
    globals: {
      COMMAND_ASSETS: {},
      _DIRS: { "~": [], home: [], work: [] },
      _filesHere: () => [],
      analyticsEvent: vi.fn(),
      config: {},
      firm: { name: "Root Ventures" },
      fitAddon: { fit: vi.fn() },
      portfolio: {},
      team: {},
      getArt: vi.fn(() => ""),
      getASCIIArtIdForCommand: vi.fn(() => null),
      getPreloadFileForCommand: vi.fn(() => null),
      help: {},
      jobs: {},
      preloadASCIIArt: vi.fn(),
      scheduleIdleTask: vi.fn(),
      shortcuts: {},
    },
  });
  Object.defineProperty(env.window, "localStorage", {
    configurable: true,
    ...(storageGetter ? { get: storageGetter } : { value: storage }),
  });

  const term = createTerm(cwd);
  env.window.term = term;
  env.loadScripts([
    "js/bookmarks.js",
    // terminal-ext.js (main) reads the Pipeline global from js/pipeline.js.
    "js/pipeline.js",
    "config/commands.js",
    "js/terminal-ext.js",
  ]);
  const { extend } = env.exportValues(["extend"]);
  extend(term);
  term.cwd = cwd;
  term.pos = () => term.currentLine.length;
  term.stylePrint = vi.fn();

  term.init = vi.fn();
  term.prompt = vi.fn();
  term.clearCurrentLine = vi.fn(() => {
    term.currentLine = "";
  });
  term.runDeepLink = vi.fn();

  env.loadScript("js/terminal.js");
  const { runRootTerminal } = env.exportValues(["runRootTerminal"]);
  runRootTerminal(term);
  term.prompt.mockClear();
  term.clearCurrentLine.mockClear();

  return { env, term };
}

async function submit(term, line) {
  for (const character of line) term.input(character);
  expect(term.currentLine).toBe(line);
  term.input("\r");
  await vi.waitFor(() => expect(term.busy).toBe(false));
}

let environments = [];
afterEach(() => {
  for (const { env } of environments) env.cleanup();
  environments = [];
});

describe("bookmark terminal integration", () => {
  it("fails closed when the browser localStorage accessor throws and keeps later scripts interactive", async () => {
    const storageGetter = vi.fn(() => {
      throw new Error("storage access denied");
    });
    const broken = createTerminalEnvironment(undefined, "work", storageGetter);
    environments.push(broken);
    const initialURL = broken.env.window.location.href;
    const beforeUnload = vi.fn();
    broken.env.window.addEventListener("beforeunload", beforeUnload);

    // Startup probes storage once for bookmarks and once for the environment
    // store (js/terminal-ext.js); the bookmark commands must never probe again.
    const startupAccesses = storageGetter.mock.calls.length;
    expect(startupAccesses).toBeGreaterThanOrEqual(1);
    expect(typeof broken.term.input).toBe("function");

    for (const [line, output] of [
      ["bookmark add desk", 'Could not save bookmark "desk": browser storage is unavailable.'],
      ["bookmark list", "Could not list bookmarks: browser storage is unavailable or corrupt."],
      ["bookmark remove desk", 'Could not remove bookmark "desk": browser storage is unavailable.'],
      ["go desk", 'Could not open bookmark "desk": browser storage is unavailable.'],
    ]) {
      broken.term.stylePrint.mockClear();
      broken.term.prompt.mockClear();
      broken.term.clearCurrentLine.mockClear();

      await submit(broken.term, line);

      expect(broken.term.stylePrint).toHaveBeenLastCalledWith(output);
      expect(broken.term.cwd).toBe("work");
      expect(broken.term.prompt).toHaveBeenCalledTimes(1);
      expect(broken.term.clearCurrentLine).toHaveBeenCalledTimes(1);
      expect(broken.term.currentLine).toBe("");
      expect(broken.term.locked).toBe(false);
      expect(broken.term.busy).toBe(false);
      expect(broken.env.window.location.href).toBe(initialURL);
      expect(beforeUnload).not.toHaveBeenCalled();
    }

    expect(storageGetter).toHaveBeenCalledTimes(startupAccesses);
  });

  it("keeps bookmark and go in the normal interactive Enter-key lifecycle", async () => {
    const storage = createSharedStorage();
    const first = createTerminalEnvironment(storage, "home");
    environments.push(first);
    const initialURL = first.env.window.location.href;
    const beforeUnload = vi.fn();
    first.env.window.addEventListener("beforeunload", beforeUnload);

    await submit(first.term, "bookmark add desk");
    expect(first.term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(first.term.prompt).toHaveBeenCalledTimes(1);
    expect(first.term.currentLine).toBe("");
    expect(first.term.locked).toBe(false);
    expect(first.term.busy).toBe(false);
    expect(first.env.window.location.href).toBe(initialURL);
    expect(beforeUnload).not.toHaveBeenCalled();

    first.term.cwd = "work";
    first.term.prompt.mockClear();
    first.term.clearCurrentLine.mockClear();
    await submit(first.term, "go missing");
    expect(first.term.stylePrint).toHaveBeenLastCalledWith('Bookmark "missing" not found.');
    expect(first.term.cwd).toBe("work");
    expect(first.term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(first.term.prompt).toHaveBeenCalledTimes(1);
    expect(first.env.window.location.href).toBe(initialURL);
    expect(beforeUnload).not.toHaveBeenCalled();

    first.term.prompt.mockClear();
    first.term.clearCurrentLine.mockClear();
    await submit(first.term, "go desk");
    expect(first.term.cwd).toBe("home");
    expect(first.term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(first.term.prompt).toHaveBeenCalledTimes(1);
    expect(first.term.currentLine).toBe("");
    expect(first.term.locked).toBe(false);
    expect(first.env.window.location.href).toBe(initialURL);
    expect(beforeUnload).not.toHaveBeenCalled();
  });

  it("keeps quoted backup JSON literal through preview, import, and export", async () => {
    const storage = createSharedStorage();
    const terminal = createTerminalEnvironment(storage, "work");
    environments.push(terminal);
    const backup = JSON.stringify({
      version: 1,
      bookmarks: [
        {
          name: "literal",
          path: '/missing path/quote"/back\\slash/雪/%bookmark%/$HOME',
        },
      ],
    });
    const quotedBackup = backup.replace("$HOME", "\\$HOME");
    const commandLine = `bookmark import --dry-run --merge '${quotedBackup}'`;
    const originalDispatch = terminal.term.dispatchCommand;
    terminal.term.dispatchCommand = vi.fn(originalDispatch);
    storage.setItem.mockClear();

    await submit(terminal.term, commandLine);

    expect(terminal.term.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(terminal.term.dispatchCommand.mock.calls[0][0]).toBe("bookmark");
    expect(terminal.term.dispatchCommand.mock.calls[0][1]).toEqual([
      "import",
      "--dry-run",
      "--merge",
      backup,
    ]);
    expect(terminal.term.stylePrint).toHaveBeenLastCalledWith(
      "Bookmark import preview: added=1, updated=0, removed=0, unchanged=0"
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(terminal.term.cwd).toBe("work");

    terminal.term.dispatchCommand.mockClear();
    terminal.term.stylePrint.mockClear();
    await submit(terminal.term, `bookmark import --merge '${quotedBackup}'`);
    expect(terminal.term.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(terminal.term.stylePrint).toHaveBeenLastCalledWith(
      "Bookmark import complete: added=1, updated=0, removed=0, unchanged=0"
    );
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(terminal.term.cwd).toBe("work");

    terminal.term.writeln.mockClear();
    terminal.term.stylePrint.mockClear();
    terminal.term.dispatchCommand.mockClear();
    await submit(terminal.term, "bookmark export");
    expect(terminal.term.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(terminal.term.writeln).toHaveBeenCalledWith(backup);
    expect(terminal.term.stylePrint).not.toHaveBeenCalled();
    expect(terminal.term.cwd).toBe("work");
  });

  it("does not dispatch JSON text as a command or expand it a second time", async () => {
    const storage = createSharedStorage();
    const terminal = createTerminalEnvironment(storage, "home");
    environments.push(terminal);
    terminal.term.environment.set("HOME", "expanded");
    const backup = JSON.stringify({
      version: 1,
      bookmarks: [{ name: "opaque", path: "eval whois $HOME %help%" }],
    });
    const originalDispatch = terminal.term.dispatchCommand;
    terminal.term.dispatchCommand = vi.fn(originalDispatch);

    await submit(terminal.term, `bookmark import --merge '${backup.replace("$HOME", "\\$HOME")}'`);

    expect(terminal.term.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(terminal.term.dispatchCommand.mock.calls[0][0]).toBe("bookmark");
    await submit(terminal.term, "bookmark export");
    expect(terminal.term.writeln).toHaveBeenLastCalledWith(backup);
    expect(terminal.term.cwd).toBe("home");
  });

  it("copy/pastes exported prototype-like bookmarks through replace and reload", async () => {
    const storage = createSharedStorage();
    const first = createTerminalEnvironment(storage, "work");
    environments.push(first);
    const backup = JSON.stringify({
      version: 1,
      bookmarks: [
        {
          name: "__proto__",
          path: '/not present/quote"/back\\slash/雪/%bookmark%/spaces',
        },
        { name: "constructor", path: "/also missing" },
      ],
    });

    await submit(first.term, `bookmark import --merge '${backup}'`);
    expect(first.term.stylePrint).toHaveBeenLastCalledWith(
      "Bookmark import complete: added=2, updated=0, removed=0, unchanged=0"
    );
    expect(first.term.cwd).toBe("work");

    first.term.writeln.mockClear();
    await submit(first.term, "bookmark export");
    expect(first.term.writeln).toHaveBeenCalledWith(backup);
    const exported = first.term.writeln.mock.calls.find(([line]) => line === backup)[0];

    await submit(first.term, "bookmark import --replace '{\"version\":1,\"bookmarks\":[]}'");
    expect(first.term.cwd).toBe("work");
    await submit(first.term, `bookmark import --replace '${exported}'`);
    expect(first.term.stylePrint).toHaveBeenLastCalledWith(
      "Bookmark import complete: added=2, updated=0, removed=0, unchanged=0"
    );
    expect(first.term.cwd).toBe("work");

    first.env.cleanup();
    environments = [];
    const reloaded = createTerminalEnvironment(storage, "home");
    environments.push(reloaded);
    await submit(reloaded.term, "bookmark export");
    expect(reloaded.term.writeln).toHaveBeenCalledWith(backup);

    await submit(reloaded.term, "go __proto__");
    expect(reloaded.term.cwd).toBe('/not present/quote"/back\\slash/雪/%bookmark%/spaces');
  });

  it("recreates the browser environment with persisted bookmarks available to list and go", async () => {
    const storage = createSharedStorage();
    const first = createTerminalEnvironment(storage, "work");
    environments.push(first);
    await submit(first.term, "bookmark add persisted");
    first.env.cleanup();
    environments = [];

    const reloaded = createTerminalEnvironment(storage, "~");
    environments.push(reloaded);
    const reloadedURL = reloaded.env.window.location.href;

    await submit(reloaded.term, "bookmark list");
    expect(reloaded.term.stylePrint).toHaveBeenCalledWith("persisted -> work");
    expect(reloaded.term.prompt).toHaveBeenCalledTimes(1);
    expect(reloaded.term.clearCurrentLine).toHaveBeenCalledTimes(1);

    reloaded.term.prompt.mockClear();
    reloaded.term.clearCurrentLine.mockClear();
    await submit(reloaded.term, "go persisted");
    expect(reloaded.term.cwd).toBe("work");
    expect(reloaded.term.prompt).toHaveBeenCalledTimes(1);
    expect(reloaded.term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(reloaded.term.currentLine).toBe("");
    expect(reloaded.term.locked).toBe(false);
    expect(reloaded.env.window.location.href).toBe(reloadedURL);
  });
});

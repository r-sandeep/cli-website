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

    expect(storageGetter).toHaveBeenCalledTimes(1);
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

    expect(storageGetter).toHaveBeenCalledTimes(1);
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

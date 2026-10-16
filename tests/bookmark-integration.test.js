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

  it("renames through literal input and preserves the full list, navigation, and reload state", async () => {
    const storage = createSharedStorage();
    const first = createTerminalEnvironment(storage, "home");
    environments.push(first);
    const initialURL = first.env.window.location.href;
    const beforeUnload = vi.fn();
    first.env.window.addEventListener("beforeunload", beforeUnload);

    await submit(first.term, "bookmark add old");
    first.term.cwd = "work";
    await submit(first.term, "bookmark add kept");
    first.term.cwd = "~";
    first.term.stylePrint.mockClear();
    first.term.prompt.mockClear();
    first.term.clearCurrentLine.mockClear();

    await submit(first.term, "bookmark rename old new");

    expect(first.term.stylePrint).toHaveBeenLastCalledWith("Bookmark old renamed to new.");
    expect(first.term.cwd).toBe("~");
    expect(first.term.prompt).toHaveBeenCalledTimes(1);
    expect(first.term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(first.term.currentLine).toBe("");
    expect(first.term.locked).toBe(false);
    expect(first.term.busy).toBe(false);
    expect(first.env.window.location.href).toBe(initialURL);
    expect(beforeUnload).not.toHaveBeenCalled();

    first.term.stylePrint.mockClear();
    await submit(first.term, "bookmark list");
    expect(first.term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "kept -> work",
      "new -> home",
    ]);
    await submit(first.term, "go new");
    expect(first.term.cwd).toBe("home");
    first.term.stylePrint.mockClear();
    await submit(first.term, "go old");
    expect(first.term.stylePrint).toHaveBeenLastCalledWith('Bookmark "old" not found.');

    first.env.cleanup();
    environments = [];
    const reloaded = createTerminalEnvironment(storage, "~");
    environments.push(reloaded);
    reloaded.term.stylePrint.mockClear();
    await submit(reloaded.term, "bookmark list");
    expect(reloaded.term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "kept -> work",
      "new -> home",
    ]);
    await submit(reloaded.term, "go new");
    expect(reloaded.term.cwd).toBe("home");
    reloaded.term.stylePrint.mockClear();
    await submit(reloaded.term, "pwd");
    expect(reloaded.term.stylePrint).toHaveBeenLastCalledWith("/home");
    expect(reloaded.term.currentLine).toBe("");
    expect(reloaded.term.locked).toBe(false);
    expect(reloaded.term.busy).toBe(false);
  });

  it("routes a normally defined alias through rename and keeps later input interactive", async () => {
    const storage = createSharedStorage();
    const run = createTerminalEnvironment(storage, "home");
    environments.push(run);
    const initialURL = run.env.window.location.href;
    await submit(run.term, "bookmark add old");
    await submit(run.term, "alias b=bookmark");
    run.term.cwd = "work";
    run.term.stylePrint.mockClear();
    run.term.prompt.mockClear();
    run.term.clearCurrentLine.mockClear();

    await submit(run.term, "b rename old new");

    expect(run.term.stylePrint).toHaveBeenLastCalledWith("Bookmark old renamed to new.");
    expect(run.term.prompt).toHaveBeenCalledTimes(1);
    expect(run.term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(run.term.currentLine).toBe("");
    expect(run.term.locked).toBe(false);
    expect(run.term.busy).toBe(false);
    expect(run.env.window.location.href).toBe(initialURL);

    run.term.stylePrint.mockClear();
    await submit(run.term, "bookmark list");
    expect(run.term.stylePrint.mock.calls.map(([line]) => line)).toEqual(["new -> home"]);
    await submit(run.term, "go new");
    expect(run.term.cwd).toBe("home");
    run.term.stylePrint.mockClear();
    await submit(run.term, "pwd");
    expect(run.term.stylePrint).toHaveBeenLastCalledWith("/home");
  });

  it("rejects rename errors and wrong arities through Enter with exact state unchanged", async () => {
    const storage = createSharedStorage();
    const initialBytes = JSON.stringify([["old", "home"], ["occupied", "work"]]);
    storage.setItem("rootvc.bookmarks.v1", initialBytes);
    const run = createTerminalEnvironment(storage, "~");
    environments.push(run);

    for (const [line, output] of [
      ["bookmark rename missing fresh", 'Bookmark "missing" not found.'],
      ["bookmark rename old occupied", 'Bookmark "occupied" already exists.'],
      ["bookmark rename 'bad.name' fresh", 'Invalid bookmark rename "bad.name" to "fresh". OLD and NEW must match [A-Za-z0-9_-]+.'],
      ["bookmark rename old ''", 'Invalid bookmark rename "old" to "". OLD and NEW must match [A-Za-z0-9_-]+.'],
      ["bookmark rename", "Usage: bookmark add NAME | bookmark list | bookmark rename OLD NEW | bookmark remove NAME"],
      ["bookmark rename old", "Usage: bookmark add NAME | bookmark list | bookmark rename OLD NEW | bookmark remove NAME"],
      ["bookmark rename old fresh extra", "Usage: bookmark add NAME | bookmark list | bookmark rename OLD NEW | bookmark remove NAME"],
    ]) {
      run.term.stylePrint.mockClear();
      run.term.prompt.mockClear();
      run.term.clearCurrentLine.mockClear();
      storage.setItem.mockClear();

      await submit(run.term, line);

      expect(run.term.stylePrint).toHaveBeenLastCalledWith(output);
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem("rootvc.bookmarks.v1")).toBe(initialBytes);
      expect(run.term.cwd).toBe("~");
      expect(run.term.prompt).toHaveBeenCalledTimes(1);
      expect(run.term.clearCurrentLine).toHaveBeenCalledTimes(1);
      expect(run.term.currentLine).toBe("");
      expect(run.term.locked).toBe(false);
      expect(run.term.busy).toBe(false);

      run.term.stylePrint.mockClear();
      await submit(run.term, "bookmark list");
      expect(run.term.stylePrint.mock.calls.map(([text]) => text)).toEqual([
        "occupied -> work",
        "old -> home",
      ]);
    }
  });

  it("keeps write and load failures atomic while later ordinary commands execute", async () => {
    const storage = createSharedStorage();
    const originalBytes = JSON.stringify([["old", "home"], ["kept", "work"]]);
    storage.setItem("rootvc.bookmarks.v1", originalBytes);
    const writeFailure = createTerminalEnvironment(storage, "~");
    environments.push(writeFailure);
    storage.setItem.mockImplementation(() => { throw new Error("full"); });

    await submit(writeFailure.term, "bookmark rename old new");
    expect(writeFailure.term.stylePrint).toHaveBeenLastCalledWith(
      'Could not rename bookmark "old" to "new": browser storage is unavailable.'
    );
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(originalBytes);
    writeFailure.term.stylePrint.mockClear();
    await submit(writeFailure.term, "bookmark list");
    expect(writeFailure.term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "kept -> work",
      "old -> home",
    ]);
    writeFailure.term.stylePrint.mockClear();
    await submit(writeFailure.term, "pwd");
    expect(writeFailure.term.stylePrint).toHaveBeenLastCalledWith("/home/guest");
    expect(writeFailure.term.currentLine).toBe("");
    expect(writeFailure.term.locked).toBe(false);
    expect(writeFailure.term.busy).toBe(false);

    for (const failedStorage of [
      {
        getItem: vi.fn(() => { throw new Error("blocked"); }),
        setItem: vi.fn(),
      },
      (() => {
        const corrupt = createSharedStorage();
        corrupt.setItem("rootvc.bookmarks.v1", "{broken");
        corrupt.setItem.mockClear();
        return corrupt;
      })(),
    ]) {
      const failed = createTerminalEnvironment(failedStorage, "work");
      environments.push(failed);
      await submit(failed.term, "bookmark rename old new");
      expect(failed.term.stylePrint).toHaveBeenLastCalledWith(
        'Could not rename bookmark "old" to "new": browser storage is unavailable.'
      );
      expect(failedStorage.setItem).not.toHaveBeenCalled();
      failed.term.stylePrint.mockClear();
      await submit(failed.term, "pwd");
      expect(failed.term.stylePrint).toHaveBeenLastCalledWith("/work");
      expect(failed.term.currentLine).toBe("");
      expect(failed.term.locked).toBe(false);
      expect(failed.term.busy).toBe(false);
    }
  });

  it("preserves special names, exact case, and write-free same-name success through Enter", async () => {
    const storage = createSharedStorage();
    storage.setItem(
      "rootvc.bookmarks.v1",
      JSON.stringify([["__proto__", "home"], ["constructor", "work"], ["Case", "~"]])
    );
    const run = createTerminalEnvironment(storage, "home");
    environments.push(run);

    await submit(run.term, "bookmark rename __proto__ toString");
    expect(run.term.stylePrint).toHaveBeenLastCalledWith(
      "Bookmark __proto__ renamed to toString."
    );
    await submit(run.term, "bookmark rename Case case");
    expect(run.term.stylePrint).toHaveBeenLastCalledWith("Bookmark Case renamed to case.");
    const bytesBeforeNoop = storage.getItem("rootvc.bookmarks.v1");
    storage.setItem.mockClear();
    await submit(run.term, "bookmark rename constructor constructor");
    expect(run.term.stylePrint).toHaveBeenLastCalledWith(
      "Bookmark constructor renamed to constructor."
    );
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(bytesBeforeNoop);
    expect(JSON.parse(bytesBeforeNoop)).toEqual([
      ["toString", "home"],
      ["constructor", "work"],
      ["case", "~"],
    ]);
    expect(run.term.cwd).toBe("home");
    expect(run.term.currentLine).toBe("");
    expect(run.term.locked).toBe(false);
    expect(run.term.busy).toBe(false);
  });
});

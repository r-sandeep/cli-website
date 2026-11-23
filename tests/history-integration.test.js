import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const HISTORY_KEY = "rootvc.history.v1";

function sharedStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    value: (key) => values.get(key),
  };
}

function createTerm() {
  const term = {
    VERSION: 4,
    _initialized: false,
    attachCustomKeyEventHandler: vi.fn((handler) => { term.keyHandler = handler; }),
    buffer: { active: { cursorX: 0 } },
    cols: 80,
    currentLine: "",
    focus: vi.fn(),
    loadAddon: vi.fn(),
    locked: false,
    onData: vi.fn((handler) => { term.input = handler; return { dispose: vi.fn() }; }),
    open: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };
  return term;
}

function createTerminal(storage, { hash = "" } = {}) {
  const term = createTerm();
  const env = createBrowserEnv({
    url: `https://www.root.vc/${hash}`,
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      _filesHere: () => [],
      buildInfo: Object.freeze({ version: "test", buildDate: "2030-01-01" }),
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      firm: { blurb: "", email: "hello@example.com" },
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      help: {}, jobs: {}, portfolio: {}, team: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn(),
      shortcuts: {},
      term,
    },
  });
  Object.defineProperty(env.window, "localStorage", { configurable: true, value: storage });
  env.loadScripts(["js/pipeline.js", "config/commands.js", "js/terminal-ext.js"]);
  const { extend } = env.exportValues(["extend"]);
  extend(term);
  term.pos = () => term.currentLine.length;
  env.loadScript("js/terminal.js");
  env.exportValues(["runRootTerminal"]).runRootTerminal(term);
  return { env, term };
}

async function enter(term, line) {
  for (const character of line) term.input(character);
  term.input("\r");
  await vi.waitFor(() => expect(term.busy).toBe(false));
}

const environments = [];
afterEach(() => {
  for (const env of environments.splice(0)) env.cleanup();
  vi.restoreAllMocks();
});

describe("saved history terminal integration", () => {
  it("hydrates before startup, recalls through production keys, and lists exact persisted order", async () => {
    const storage = sharedStorage();
    const first = createTerminal(storage); environments.push(first.env);
    await enter(first.term, "ping");
    await enter(first.term, "pwd");
    expect(first.term.history).toEqual(["ping", "pwd"]);

    const second = createTerminal(storage); environments.push(second.env);
    expect(second.term.history).toEqual(["ping", "pwd"]);
    expect(second.term.visitHistory).toEqual([]);
    second.term.input("\x1b[A");
    expect(second.term.currentLine).toBe("pwd");
    second.term.input("\r");
    await vi.waitFor(() => expect(second.term.busy).toBe(false));
    await enter(second.term, "history");

    expect(second.term.history).toEqual(["ping", "pwd", "pwd", "history"]);
    expect(second.term.writeln.mock.calls.map(([line]) => line)).toEqual(
      expect.arrayContaining([
        "1000  ping", "1001  pwd", "1002  pwd", "1003  history",
      ])
    );
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(second.term.history);
  });

  it("records every non-empty branch before preload and excludes blank, deep-link, and replay input", async () => {
    const storage = sharedStorage();
    const state = createTerminal(storage, { hash: "#ping" }); environments.push(state.env);
    const { term } = state;
    const pending = {};
    term.preloadCommandAssets = vi.fn((line) =>
      line === "asset-failure" ? new Promise((_, reject) => { pending.reject = reject; }) : Promise.resolve()
    );

    const assetRun = term.executeCommandLine("asset-failure");
    expect(term.history).toEqual(["asset-failure"]);
    pending.reject(new Error("asset unavailable"));
    await assetRun;
    await term.executeCommandLine("ping | wc -l");
    await term.executeCommandLine("ping | mystery");
    await term.executeCommandLine("oops");
    await term.executeCommandLine("   ");
    await term.runDeepLink();
    const beforeReplay = [...term.history];
    await term.executeCommandLine("ping", { addToHistory: false, trackAnalytics: false });

    expect(term.history).toEqual([
      "asset-failure", "ping | wc -l", "ping | mystery", "oops",
    ]);
    expect(term.history).toEqual(beforeReplay);
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(term.history);
    expect(term.writeln.mock.calls.flat().join("\n")).toContain("Command not found: oops");
  });

  it("bounds the real consumers at 200 while retaining numbering and reset history", async () => {
    const seeded = Array.from({ length: 199 }, (_, index) => `saved-${index}`);
    const storage = sharedStorage({ [HISTORY_KEY]: JSON.stringify(seeded) });
    const state = createTerminal(storage); environments.push(state.env);
    await enter(state.term, "ping");
    expect(state.term.history).toEqual([...seeded, "ping"]);
    await enter(state.term, "clear");
    expect(state.term.history).toEqual([...seeded.slice(1), "ping", "clear"]);
    expect(state.term.visitHistory).toEqual([]);
    state.term.input("\x1b[A");
    expect(state.term.currentLine).toBe("clear");
    state.term.input("\u0003");
    await enter(state.term, "history");

    expect(state.term.history).toHaveLength(200);
    expect(state.term.history.at(-1)).toBe("history");
    expect(state.term.writeln).toHaveBeenCalledWith("1000  saved-2");
    expect(state.term.writeln).toHaveBeenCalledWith("1199  history");
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(state.term.history);
  });

  it("keeps production input usable in memory after history writes fail", async () => {
    const storage = sharedStorage({
      [HISTORY_KEY]: JSON.stringify(["saved"]),
      "rootvc.aliases": "[]",
      "rootvc.cli.environment.v1": JSON.stringify({ version: 1, variables: [] }),
      "rootvc.bookmarks.v1": "[]",
    });
    const state = createTerminal(storage); environments.push(state.env);
    const persisted = storage.value(HISTORY_KEY);
    storage.setItem.mockImplementation((key, value) => {
      if (key === HISTORY_KEY) throw new Error("quota");
      storage.setItem.getMockImplementation()?.(key, value);
    });

    await enter(state.term, "ping");
    await enter(state.term, "pwd");
    await enter(state.term, "clear");
    await enter(state.term, "ping");

    expect(state.term.history).toEqual(["saved", "ping", "pwd", "clear", "ping"]);
    expect(storage.value(HISTORY_KEY)).toBe(persisted);
    expect(storage.value("rootvc.aliases")).toBe("[]");
    expect(state.term.busy).toBe(false);
    expect(state.term.locked).toBe(false);
    expect(state.term.currentLine).toBe("");
    expect(state.term.writeln.mock.calls.flat().join("\n")).toContain("pong");
  });
});

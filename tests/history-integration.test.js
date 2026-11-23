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
      firm: {
        blurb: "",
        checkSize: "$1m",
        email: "hello@example.com",
        fundSize: "$100m",
        tagline: "Builders first",
        thesis: "Hard problems",
      },
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
  env.loadScripts(["js/pipeline.js", "js/bookmarks.js", "config/commands.js", "js/terminal-ext.js"]);
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

function accelerateUpgrade(term) {
  term.progressBar = vi.fn(() => Promise.resolve());
  term.delayStylePrint = vi.fn(() => Promise.resolve());
  term.dottedPrint = vi.fn(() => Promise.resolve());
  term.delayPrint = vi.fn(() => Promise.resolve());
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

  it.each(["clear", "zsh", "upgrade"])(
    "%s resets display replay while retaining bounded recall and durable history",
    async (resetCommand) => {
      const seeded = Array.from({ length: 200 }, (_, index) => `old-${index}`);
      const storage = sharedStorage({ [HISTORY_KEY]: JSON.stringify(seeded) });
      const state = createTerminal(storage); environments.push(state.env);
      if (resetCommand === "upgrade") accelerateUpgrade(state.term);

      await enter(state.term, resetCommand);

      const expected = [...seeded.slice(1), resetCommand];
      expect(state.term.history).toEqual(expected);
      expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(expected);
      expect(state.term.visitHistory).toEqual([]);
      expect(state.term.locked).toBe(false);
      state.term.input("\x1b[A");
      expect(state.term.currentLine).toBe(resetCommand);
      state.term.input("\u0003");
      await enter(state.term, "ping");
      expect(state.term.history).toEqual([...expected.slice(1), "ping"]);
      expect(state.term.writeln.mock.calls.flat().join("\n")).toContain("pong");
      if (resetCommand === "upgrade") expect(state.term.VERSION).toBe(4);
    }
  );

  it.each(["clear", "zsh", "upgrade"])(
    "%s retains memory history when browser writes are denied",
    async (resetCommand) => {
      const storage = sharedStorage({ [HISTORY_KEY]: JSON.stringify(["saved"]) });
      const state = createTerminal(storage); environments.push(state.env);
      if (resetCommand === "upgrade") accelerateUpgrade(state.term);
      const persisted = storage.value(HISTORY_KEY);
      storage.setItem.mockImplementation((key) => {
        if (key === HISTORY_KEY) throw new Error("quota");
      });

      await enter(state.term, resetCommand);
      expect(state.term.history).toEqual(["saved", resetCommand]);
      expect(storage.value(HISTORY_KEY)).toBe(persisted);
      expect(state.term.visitHistory).toEqual([]);
      expect(state.term.locked).toBe(false);
      await enter(state.term, "ping");
      expect(state.term.history).toEqual(["saved", resetCommand, "ping"]);
      expect(state.term.busy).toBe(false);
    }
  );

  it.each([
    ["missing localStorage accessor", () => { throw new Error("denied"); }],
    ["failed history read", () => ({
      getItem(key) {
        if (key === HISTORY_KEY) throw new Error("denied read");
        return null;
      },
      setItem: vi.fn(),
    })],
  ])("continues through production input after %s", async (_label, storageFactory) => {
    const term = createTerm();
    const env = createBrowserEnv({
      globals: {
        LOGO_TYPE: "ROOT", _DIRS: { "~": [] }, _filesHere: () => [],
        buildInfo: {}, ensureASCIIArt: vi.fn(), ensureFileLoaded: vi.fn(),
        firm: { blurb: "", email: "hello@example.com" },
        fitAddon: { fit: vi.fn() }, getASCIIArtIdForCommand: vi.fn(() => null),
        getArt: vi.fn(() => ""), getPreloadFileForCommand: vi.fn(() => null),
        help: {}, jobs: {}, portfolio: {}, preloadASCIIArt: vi.fn(),
        scheduleIdleTask: vi.fn(), shortcuts: {}, team: {}, term,
      },
    });
    environments.push(env);
    Object.defineProperty(env.window, "localStorage", {
      configurable: true,
      get: storageFactory,
    });
    env.loadScripts(["js/pipeline.js", "js/bookmarks.js", "config/commands.js", "js/terminal-ext.js"]);
    env.exportValues(["extend"]).extend(term);
    term.pos = () => term.currentLine.length;
    env.loadScript("js/terminal.js");
    env.exportValues(["runRootTerminal"]).runRootTerminal(term);

    await enter(term, "ping");
    await enter(term, "pwd");
    expect(term.history).toEqual(["ping", "pwd"]);
    term.input("\x1b[A");
    expect(term.currentLine).toBe("pwd");
    term.input("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    expect(term.history).toEqual(["ping", "pwd", "pwd"]);
    expect(term.writeln.mock.calls.flat().join("\n")).toContain("/home/guest");
  });

  it("preserves alias, environment, bookmark and deep-link state around history use", async () => {
    const storage = sharedStorage({
      [HISTORY_KEY]: JSON.stringify(["saved"]),
      "rootvc.aliases": JSON.stringify([["p", "ping"]]),
      "rootvc.cli.environment.v1": JSON.stringify({
        version: 1, variables: [["KEEP", "original"]],
      }),
      "rootvc.bookmarks.v1": JSON.stringify([["desk", "projects"]]),
    });
    const state = createTerminal(storage, { hash: "#p" }); environments.push(state.env);
    const { env, term } = state;
    await vi.waitFor(() => expect(env.window.dataLayer?.length).toBe(1));
    expect(term.history).toEqual(["saved"]);
    expect(term.getAliases()).toEqual([["p", "ping"]]);
    expect(Array.from(term.environment.snapshot().entries())).toEqual([["KEEP", "original"]]);
    await enter(term, "p");
    await enter(term, "go desk");
    expect(term.cwd).toBe("projects");
    expect(storage.value("rootvc.aliases")).toBe(JSON.stringify([["p", "ping"]]));
    expect(storage.value("rootvc.cli.environment.v1")).toBe(JSON.stringify({
      version: 1, variables: [["KEEP", "original"]],
    }));
    expect(storage.value("rootvc.bookmarks.v1")).toBe(JSON.stringify([["desk", "projects"]]));
    expect(term.history).toEqual(["saved", "p", "go desk"]);
    expect(env.window.dataLayer.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "p", args: "" },
      { command: "p", args: "" },
      { command: "go", args: "desk" },
    ]);
  });

  it("redraws only current-visit commands without duplicating history or analytics", async () => {
    const storage = sharedStorage({
      [HISTORY_KEY]: JSON.stringify(["export RESTORED=must-not-run", "pwd"]),
    });
    const state = createTerminal(storage, { hash: "#ping" }); environments.push(state.env);
    const { env, term } = state;
    await vi.waitFor(() => expect(env.window.dataLayer?.length).toBe(1));
    expect(term.environment.get("RESTORED")).toBeUndefined();
    await enter(term, "ping | wc -l");
    await enter(term, "ping | mystery");
    const expectedHistory = [
      "export RESTORED=must-not-run", "pwd", "ping | wc -l", "ping | mystery",
    ];
    expect(term.history).toEqual(expectedHistory);
    const analyticsBeforeResize = env.window.dataLayer.map((event) => ({ ...event }));

    let nextCols = 40;
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = nextCols; });
    await term.resizeListener();
    expect(term.history).toEqual(expectedHistory);
    expect(term.environment.get("RESTORED")).toBeUndefined();
    expect(env.window.dataLayer).toEqual(analyticsBeforeResize);
    expect(term.writeln.mock.calls.flat().join("\n")).toContain("1");
    expect(term.writeln.mock.calls.flat().join("\n")).toContain("Unknown pipeline filter: mystery");

    nextCols = 100;
    await term.resizeListener();
    expect(term.history).toEqual(expectedHistory);
    expect(env.window.dataLayer).toEqual(analyticsBeforeResize);
    await enter(term, "ping");
    expect(term.history).toEqual([...expectedHistory, "ping"]);
  });
});

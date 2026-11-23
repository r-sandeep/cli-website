import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function createTerm(overrides = {}) {
  const term = {
    _initialized: false,
    VERSION: 4,
    buffer: { active: { cursorX: 0 } },
    busy: false,
    clearCurrentLine: vi.fn(),
    cols: 80,
    currentLine: "",
    focus: vi.fn(),
    locked: false,
    reset: vi.fn(),
    runDeepLink: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    ...overrides,
  };
  term.attachCustomKeyEventHandler = vi.fn((handler) => {
    term._customKeyHandler = handler;
  });
  term.onData = vi.fn((handler) => {
    term._onData = handler;
    return { dispose: vi.fn() };
  });
  return term;
}

function loadIntegration({ commands = {}, dataLayer = [] } = {}) {
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      colorText: (text) => text,
      commands,
      dataLayer,
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      jobs: {},
      portfolio: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      team: {},
      _filesHere: () => [],
    },
  });
  env.loadScripts(["js/history.js", "js/pipeline.js", "js/terminal-ext.js", "js/terminal.js"]);
  return env.exportValues(["extend", "runRootTerminal"]);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("saved terminal history integration", () => {
  it("restores recall before the first prompt without dispatch or analytics", async () => {
    const dispatched = vi.fn();
    const dataLayer = [];
    const { extend, runRootTerminal } = loadIntegration({ dataLayer });
    const term = createTerm();
    extend(term);
    term.dispatchCommand = dispatched;

    const saved = ["echo one", "echo two", "echo two"];
    Object.defineProperty(term, "historyReady", {
      configurable: true,
      value: Promise.resolve().then(() => {
        term.history = [...saved];
        term.historyCursor = -1;
      }),
    });

    await term.historyReady;
    expect(term.reset).not.toHaveBeenCalled();
    expect(term.focus).not.toHaveBeenCalled();
    expect(dispatched).not.toHaveBeenCalled();
    expect(dataLayer).toEqual([]);

    runRootTerminal(term);
    expect(term.init).toBeDefined();
    expect(term.history).toEqual(saved);
    expect(term.currentLine).toBe("");
    expect(term.historyCursor).toBe(-1);

    term._onData("\x1b[A");
    expect(term.currentLine).toBe("echo two");
    expect(dispatched).not.toHaveBeenCalled();
    expect(dataLayer).toEqual([]);
  });

  it("records every submission branch once and excludes internal input paths", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = vi.fn();
    const throws = vi.fn(() => {
      throw "controlled command failure";
    });
    const { extend } = loadIntegration({ commands: { ok, throws } });
    const term = createTerm();
    extend(term);
    await term.historyReady;

    await term.executeCommandLine("ok", { promptAfter: false });
    await term.executeCommandLine("missing", { promptAfter: false });
    await term.executeCommandLine("ok | head 1", { promptAfter: false });
    await term.executeCommandLine("ok | head 0", { promptAfter: false });
    await term.executeCommandLine("   ", { promptAfter: false });
    await term.executeCommandLine("public suppressed option", {
      addToHistory: false,
      promptAfter: false,
    });
    term.deepLink = "actual deep link";
    await term.runDeepLink();

    expect(term.history).toEqual([
      "ok",
      "missing",
      "ok | head 1",
      "ok | head 0",
      "public suppressed option",
    ]);
    expect(ok).toHaveBeenCalledTimes(2);
    expect(throws).not.toHaveBeenCalled();
  });

  it("caps recall and keeps history numbering unchanged through the production renderer", async () => {
    let term;
    const history = vi.fn(() => {
      term.history.forEach((line, index) => term.stylePrint(`${1000 + index}  ${line}`));
    });
    const { extend } = loadIntegration({ commands: { history } });
    term = createTerm();
    extend(term);
    await term.historyReady;

    for (let index = 0; index <= 200; index += 1) {
      await term.executeCommandLine(`missing ${index}`, { promptAfter: false });
    }
    expect(term.history).toEqual(
      Array.from({ length: 200 }, (_, index) => `missing ${index + 1}`)
    );

    const listing = [];
    term.stylePrint = vi.fn((line) => listing.push(line));
    await term.executeCommandLine("history", { promptAfter: false });
    expect(term.history).toHaveLength(200);
    expect(term.history[0]).toBe("missing 2");
    expect(term.history.at(-1)).toBe("history");
    expect(listing[0]).toBe("1000  missing 2");
    expect(listing.at(-1)).toBe("1199  history");
  });

  it("resets only current recall/replay and does not let restored entries run on resize", async () => {
    const restored = vi.fn();
    const fresh = vi.fn();
    const { extend } = loadIntegration({ commands: { restored, fresh } });
    const term = createTerm();
    extend(term);
    await term.historyReady;
    term.history = ["restored"];
    term.runDeepLink = vi.fn();
    env.window.__term = term;
    let nextCols = 100;
    env.window.fitAddon.fit = vi.fn(() => {
      term.cols = nextCols;
    });

    await term.resizeListener();
    expect(restored).not.toHaveBeenCalled();

    await term.executeCommandLine("fresh", { promptAfter: false });
    fresh.mockClear();
    nextCols = 120;
    await term.resizeListener();
    expect(restored).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledTimes(1);

    term.init("guest");
    expect(term.history).toEqual([]);
    fresh.mockClear();
    nextCols = 140;
    await term.resizeListener();
    expect(fresh).not.toHaveBeenCalled();
  });

  it("fits without replaying a command whose first execution is still preparing", async () => {
    let releasePreload;
    const preload = new Promise((resolve) => { releasePreload = resolve; });
    const pending = vi.fn();
    const { extend } = loadIntegration({ commands: { pending } });
    const term = createTerm();
    extend(term);
    await term.historyReady;
    env.window.__term = term;
    term.preloadCommandAssets = vi.fn(() => preload);
    term.runDeepLink = vi.fn();
    env.window.fitAddon.fit = vi.fn(() => { term.cols += 20; });

    const execution = term.executeCommandLine("pending", { promptAfter: false });
    await Promise.resolve();
    await term.resizeListener();
    await term.resizeListener();

    expect(env.window.fitAddon.fit).toHaveBeenCalledTimes(2);
    expect(term.reset).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(env.window.dataLayer).toEqual([]);

    releasePreload();
    await execution;
    expect(pending).toHaveBeenCalledTimes(1);
    expect(term.history).toEqual(["pending"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "pending", args: "" },
    ]);
  });

  it("does not publish late completed work across a visit reset", async () => {
    let releaseCommand;
    const command = vi.fn(() => new Promise((resolve) => { releaseCommand = resolve; }));
    const ping = vi.fn();
    const { extend } = loadIntegration({ commands: { command, ping } });
    const term = createTerm();
    extend(term);
    await term.historyReady;
    env.window.__term = term;
    let nextCols = 100;
    env.window.fitAddon.fit = vi.fn(() => { term.cols = nextCols; });

    const pending = term.executeCommandLine("command", { promptAfter: false });
    await Promise.resolve();
    term.init("guest");
    expect(term.history).toEqual([]);

    releaseCommand();
    await pending;
    nextCols = 120;
    await term.resizeListener();
    expect(command).toHaveBeenCalledTimes(1);

    await term.executeCommandLine("ping", { promptAfter: false });
    expect(ping).toHaveBeenCalledTimes(1);
    expect(term.history).toEqual(["ping"]);
  });
});

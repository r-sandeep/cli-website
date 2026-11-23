import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function createTerm(overrides = {}) {
  const term = {
    VERSION: 4,
    buffer: { active: { cursorX: 0 } },
    cols: 80,
    currentLine: "",
    focus: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    ...overrides,
  };
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
    await term.executeCommandLine("deep link", {
      addToHistory: false,
      promptAfter: false,
    });

    expect(term.history).toEqual([
      "ok",
      "missing",
      "ok | head 1",
      "ok | head 0",
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

    term.stylePrint.mockClear();
    await term.executeCommandLine("history", { promptAfter: false });
    expect(term.history).toHaveLength(200);
    expect(term.history[0]).toBe("missing 2");
    expect(term.history.at(-1)).toBe("history");
    const listing = term.stylePrint.mock.calls.map(([line]) => line);
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
});

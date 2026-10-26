import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadHistoryTerminal({
  savedHistory = [],
  savedHistoryBytes,
  failHistoryRead = false,
} = {}) {
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      buildInfo: Object.freeze({ version: "test", buildDate: "2030-01-01" }),
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
  env.window.localStorage.setItem(
    "rootvc.history",
    savedHistoryBytes === undefined ? JSON.stringify(savedHistory) : savedHistoryBytes
  );
  const storagePrototype = Object.getPrototypeOf(env.window.localStorage);
  const savedGetItem = storagePrototype.getItem;
  if (failHistoryRead) {
    storagePrototype.getItem = vi.fn(() => { throw new Error("read denied"); });
  }
  const term = {
    VERSION: 4,
    _core: { buffer: { x: 0 } },
    cols: 200,
    currentLine: "",
    focus: vi.fn(),
    loadAddon: vi.fn(),
    open: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };
  env.window.term = term;
  try {
    env.loadScripts([
      "js/history.js",
      "js/pipeline.js",
      "config/commands.js",
      "js/terminal-ext.js",
    ]);
    const { extend } = env.exportValues(["extend"]);
    extend(term);
  } finally {
    storagePrototype.getItem = savedGetItem;
  }
  term.preloadCommandAssets = vi.fn(() => Promise.resolve());
  return term;
}

const output = (term) => term.writeln.mock.calls.map(([line]) => String(line));
const savedBytes = () => env.window.localStorage.getItem("rootvc.history");

async function execute(term, line) {
  term.writeln.mockClear();
  await term.executeCommandLine(line, {
    promptAfter: false,
    scrollAfter: false,
    showLeadingNewline: false,
    trackAnalytics: false,
  });
  return output(term);
}

async function withThrowingStorageWrites(
  storage,
  callback,
  { afterSetItemInstalled } = {},
) {
  const prototype = Object.getPrototypeOf(storage);
  const spies = [];
  const faultCalls = { setItem: 0, removeItem: 0 };
  try {
    const setItem = vi.spyOn(prototype, "setItem").mockImplementation(() => {
      faultCalls.setItem += 1;
      throw new Error("quota");
    });
    spies.push(setItem);
    afterSetItemInstalled?.(setItem, faultCalls);
    const removeItem = vi.spyOn(prototype, "removeItem").mockImplementation(() => {
      faultCalls.removeItem += 1;
      throw new Error("denied");
    });
    spies.push(removeItem);
    return await callback({ setItem, removeItem, faultCalls });
  } finally {
    for (const spy of spies.reverse()) spy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  env?.cleanup();
  env = undefined;
});

describe("persistent public history integration", () => {
  it("records each raw interactive submission once before every executor outcome", async () => {
    const term = loadHistoryTerminal();
    term.defineAlias("say", "echo alias");
    term.environment.set("NAME", "Expanded Value");
    const rawLines = [
      "  echo Mixed 'quote value' $NAME  ",
      "  echo Mixed 'quote value' $NAME  ",
      "say caller",
      "echo A | wc -l",
      "echo A | head 0",
      "missing-command",
      "echo prepare-failure",
    ];

    for (const line of rawLines.slice(0, -1)) await execute(term, line);
    term.preloadCommandAssets.mockRejectedValueOnce(new Error("asset rejected"));
    expect(await execute(term, rawLines.at(-1))).toContain(
      "Command failed to load required assets. Please try again."
    );

    expect(term.history).toEqual(rawLines);
    expect(JSON.parse(savedBytes())).toEqual(rawLines);
    await term.executeCommandLine("echo redirect", {
      addToHistory: false,
      promptAfter: false,
      scrollAfter: false,
      showLeadingNewline: false,
      trackAnalytics: false,
    });
    await term.executeCommandLine("echo deep-link", {
      addToHistory: false,
      promptAfter: false,
      scrollAfter: false,
      showLeadingNewline: false,
      trackAnalytics: false,
    });
    expect(term.history).toEqual(rawLines);
    expect(JSON.parse(savedBytes())).toEqual(rawLines);

    env.cleanup();
    env = undefined;
    const reloaded = loadHistoryTerminal({ savedHistory: rawLines });
    expect(reloaded.history).toEqual(rawLines);
  });

  it("lists chronologically and searches quoted literals without recording management", async () => {
    const entries = ["echo Alpha beta", "echo a.b", "echo ALPHA BETA", "echo other"];
    const term = loadHistoryTerminal({ savedHistory: entries });
    const before = savedBytes();

    expect(await execute(term, "history")).toEqual([
      "1 echo Alpha beta",
      "2 echo a.b",
      "3 echo ALPHA BETA",
      "4 echo other",
    ]);
    expect(await execute(term, 'history search "alpha beta"')).toEqual([
      "1 echo Alpha beta",
      "3 echo ALPHA BETA",
    ]);
    expect(await execute(term, "history search a.b")).toEqual(["2 echo a.b"]);
    expect(await execute(term, "HiStOrY search ALPHA BETA")).toEqual([
      "1 echo Alpha beta",
      "3 echo ALPHA BETA",
    ]);
    expect(await execute(term, "history search absent")).toEqual([
      'No history entries match "absent".',
    ]);
    expect(term.history).toEqual(entries);
    expect(savedBytes()).toBe(before);
  });

  it("renders public history data literally while preserving raw memory and storage", async () => {
    const controlEntry = "echo %ping% https://example.com/\u001b[2J\u009b31m\u007f";
    const entries = [controlEntry, controlEntry, "echo ordinary quoted value"];
    const term = loadHistoryTerminal({ savedHistory: entries });
    const storedBefore = savedBytes();
    const stylePrint = vi.spyOn(term, "stylePrint");

    expect(await execute(term, "history")).toEqual([
      "1 echo %ping% https://example.com/\\x1b[2J\\x9b31m\\x7f",
      "2 echo %ping% https://example.com/\\x1b[2J\\x9b31m\\x7f",
      "3 echo ordinary quoted value",
    ]);
    expect(stylePrint).not.toHaveBeenCalled();
    expect(term.history).toEqual(entries);
    expect(savedBytes()).toBe(storedBefore);

    stylePrint.mockClear();
    expect(await execute(term, "history search EXAMPLE.COM")).toEqual([
      "1 echo %ping% https://example.com/\\x1b[2J\\x9b31m\\x7f",
      "2 echo %ping% https://example.com/\\x1b[2J\\x9b31m\\x7f",
    ]);
    expect(stylePrint).not.toHaveBeenCalled();
    expect(term.history).toEqual(entries);
    expect(savedBytes()).toBe(storedBefore);

    stylePrint.mockClear();
    expect(await execute(term, "history search missing\u001b[2J")).toEqual([
      'No history entries match "missing\\x1b[2J".',
    ]);
    expect(stylePrint).not.toHaveBeenCalled();
    expect(term.history).toEqual(entries);
    expect(savedBytes()).toBe(storedBefore);

    term.stylePrint("trusted \u001b[31mstyled\u001b[0m");
    expect(output(term).at(-1)).toContain("\u001b[31mstyled\u001b[0m");
  });

  it("keeps direct and aliased invalid management forms nonmutating", async () => {
    const entries = ["echo one", "echo two"];
    const term = loadHistoryTerminal({ savedHistory: entries });
    term.defineAlias("h", "history");
    const before = savedBytes();

    for (const line of [
      "history clear extra",
      "history search",
      'history search " "',
      "history unknown",
      "HiStOrY unknown",
      '"history" unknown',
      "h clear extra",
    ]) {
      expect(await execute(term, line)).toEqual([
        "Usage: history | history search TEXT | history clear",
      ]);
      expect(term.history).toEqual(entries);
      expect(savedBytes()).toBe(before);
    }

    expect(await execute(term, "historylike ordinary")).toEqual([
      "Command not found: historylike. Try 'help' to get started.",
    ]);
    expect(term.history).toEqual([...entries, "historylike ordinary"]);
  });

  it("keeps ordinary execution and session history usable after malformed or failed reads", async () => {
    let term = loadHistoryTerminal({ savedHistoryBytes: "{malformed" });
    expect(await execute(term, "echo MALFORMED")).toEqual([
      "MALFORMED",
      "History recorded for this session, but could not be saved to browser\r\nstorage.",
    ]);
    expect(term.history).toEqual(["echo MALFORMED"]);
    expect(savedBytes()).toBe("{malformed");

    env.cleanup();
    env = undefined;
    term = loadHistoryTerminal({
      savedHistory: ["echo unread"],
      failHistoryRead: true,
    });
    expect(await execute(term, "echo READFAIL")).toEqual([
      "READFAIL",
      "History recorded for this session, but could not be saved to browser\r\nstorage.",
    ]);
    expect(term.history).toEqual(["echo READFAIL"]);
    expect(savedBytes()).toBe(JSON.stringify(["echo unread"]));
    expect(await execute(term, "history clear")).toEqual(["History cleared."]);
    expect(savedBytes()).toBeNull();
  });

  it("restores storage fault spies when their scoped fixture unwinds through an exception", async () => {
    loadHistoryTerminal({ savedHistory: ["echo saved"] });
    const storage = env.window.localStorage;
    const prototype = Object.getPrototypeOf(storage);
    const originalSetItem = prototype.setItem;
    const originalRemoveItem = prototype.removeItem;
    const sentinel = new Error("intentional storage fixture unwind");
    let setItemFault;
    let removeItemFault;
    let faultCalls;
    let caught;

    try {
      await withThrowingStorageWrites(storage, async (faults) => {
        setItemFault = faults.setItem;
        removeItemFault = faults.removeItem;
        faultCalls = faults.faultCalls;
        expect(() => storage.setItem("storage-fixture-proof", "blocked")).toThrow("quota");
        expect(() => storage.removeItem("storage-fixture-proof")).toThrow("denied");
        expect(setItemFault).toHaveBeenCalledTimes(1);
        expect(removeItemFault).toHaveBeenCalledTimes(1);
        throw sentinel;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(prototype.setItem).toBe(originalSetItem);
    expect(prototype.removeItem).toBe(originalRemoveItem);
    expect(faultCalls).toEqual({ setItem: 1, removeItem: 1 });

    storage.setItem("storage-fixture-proof", "restored");
    expect(storage.getItem("storage-fixture-proof")).toBe("restored");
    storage.removeItem("storage-fixture-proof");
    expect(storage.getItem("storage-fixture-proof")).toBeNull();
    expect(faultCalls).toEqual({ setItem: 1, removeItem: 1 });
  });

  it("restores an acquired storage spy when later fault setup rejects", async () => {
    loadHistoryTerminal({ savedHistory: ["echo saved"] });
    const storage = env.window.localStorage;
    const prototype = Object.getPrototypeOf(storage);
    const originalSetItem = prototype.setItem;
    const originalRemoveItem = prototype.removeItem;
    const sentinel = new Error("intentional storage fault setup failure");
    let setItemFault;
    let faultCalls;
    let caught;
    const callback = vi.fn();

    try {
      await withThrowingStorageWrites(
        storage,
        callback,
        {
          afterSetItemInstalled(spy, calls) {
            setItemFault = spy;
            faultCalls = calls;
            throw sentinel;
          },
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(sentinel);
    expect(callback).not.toHaveBeenCalled();
    expect(prototype.setItem).toBe(originalSetItem);
    expect(prototype.removeItem).toBe(originalRemoveItem);
    expect(setItemFault).toHaveBeenCalledTimes(0);
    expect(faultCalls).toEqual({ setItem: 0, removeItem: 0 });
    expect(vi.isMockFunction(prototype.setItem)).toBe(false);
    expect(vi.isMockFunction(prototype.removeItem)).toBe(false);

    storage.setItem("storage-fixture-setup-proof", "restored");
    expect(storage.getItem("storage-fixture-setup-proof")).toBe("restored");
    storage.removeItem("storage-fixture-setup-proof");
    expect(storage.getItem("storage-fixture-setup-proof")).toBeNull();
    expect(faultCalls).toEqual({ setItem: 0, removeItem: 0 });
  });

  it("reports failed persistence and clear honestly while preserving session execution", async () => {
    const term = loadHistoryTerminal({ savedHistory: ["echo saved"] });
    const storage = env.window.localStorage;
    let setItemFault;
    let removeItemFault;
    let faultCalls;

    await withThrowingStorageWrites(storage, async (faults) => {
      setItemFault = faults.setItem;
      removeItemFault = faults.removeItem;
      faultCalls = faults.faultCalls;
      expect(await execute(term, "echo SESSION")).toEqual([
        "SESSION",
        "History recorded for this session, but could not be saved to browser\r\nstorage.",
      ]);
      expect(term.history).toEqual(["echo saved", "echo SESSION"]);

      expect(await execute(term, "history clear")).toEqual([
        "History cleared for this session, but saved history could not be erased and\r\nmay return after reload.",
      ]);
      expect(term.history).toEqual([]);
      expect(savedBytes()).toBe(JSON.stringify(["echo saved"]));
    });

    const failedSetCalls = faultCalls.setItem;
    const failedRemoveCalls = faultCalls.removeItem;
    expect(failedSetCalls).toBeGreaterThan(0);
    expect(failedRemoveCalls).toBeGreaterThan(0);
    expect(Object.getPrototypeOf(storage).setItem).not.toBe(setItemFault);
    expect(Object.getPrototypeOf(storage).removeItem).not.toBe(removeItemFault);
    expect(await execute(term, "echo AFTER")).toEqual([
      "AFTER",
      "History recorded for this session, but could not be saved to browser\r\nstorage.",
    ]);
    expect(savedBytes()).toBe(JSON.stringify(["echo saved"]));
    expect(await execute(term, "history clear")).toEqual(["History cleared."]);
    expect(savedBytes()).toBeNull();
    expect(term.history).toEqual([]);
    expect(faultCalls).toEqual({
      setItem: failedSetCalls,
      removeItem: failedRemoveCalls,
    });
  });
});

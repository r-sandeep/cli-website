import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const HISTORY_KEY = "rootvc.history.v1";

function sharedQuotaStorage(limit, initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, String(value)])
  );
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => {
      const candidate = new Map(values);
      candidate.set(key, String(value));
      const size = [...candidate.values()].reduce(
        (total, stored) => total + stored.length,
        0
      );
      if (size > limit) throw new Error("quota exceeded");
      values.clear();
      for (const [storedKey, storedValue] of candidate) {
        values.set(storedKey, storedValue);
      }
    }),
    removeItem: vi.fn((key) => values.delete(key)),
    snapshot: () => Object.fromEntries(values),
    value: (key) => values.get(key),
  };
}

let env;
afterEach(() => env?.cleanup());

function loadHelper() {
  env = createBrowserEnv();
  env.loadScript("js/browser-storage.js");
  return env.exportValues(["writeBrowserSetting"]).writeBrowserSetting;
}

describe("browser setting storage priority", () => {
  it("keeps exact history bytes on an ordinary setting write", () => {
    const history = JSON.stringify(["ping"]);
    const setting = JSON.stringify([["p", "ping"]]);
    const storage = sharedQuotaStorage(history.length + setting.length, {
      [HISTORY_KEY]: history,
    });

    loadHelper()(storage, "rootvc.aliases", setting);

    expect(storage.snapshot()).toEqual({
      [HISTORY_KEY]: history,
      "rootvc.aliases": setting,
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["zero entries", JSON.stringify([]), false],
    ["one entry", JSON.stringify(["ping"]), true],
    [
      "200 entries",
      JSON.stringify(Array.from({ length: 200 }, (_, index) => `command-${index}`)),
      true,
    ],
  ])("handles %s without a fixed history reserve", (_label, history, yields) => {
    const setting = JSON.stringify([["p", "ping"]]);
    const sentinel = "keep";
    const limit =
      setting.length + sentinel.length + (yields ? 0 : history.length);
    const storage = sharedQuotaStorage(limit, {
      [HISTORY_KEY]: history,
      sentinel,
    });
    const write = loadHelper();

    if (yields) {
      write(storage, "rootvc.aliases", setting);
      expect(storage.snapshot()).toEqual({
        sentinel,
        "rootvc.aliases": setting,
      });
    } else {
      write(storage, "rootvc.aliases", setting);
      expect(storage.snapshot()).toEqual({
        [HISTORY_KEY]: history,
        sentinel,
        "rootvc.aliases": setting,
      });
    }
  });

  it("restores exact history after a failed retry and rethrows the original error", () => {
    const history = '["ping", "pwd"]';
    const storage = sharedQuotaStorage(history.length + 5, {
      [HISTORY_KEY]: history,
      sentinel: "keep",
    });
    const write = loadHelper();

    let error;
    try {
      write(storage, "rootvc.aliases", "x".repeat(100));
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({ message: "quota exceeded" });
    expect(storage.snapshot()).toEqual({
      [HISTORY_KEY]: history,
      sentinel: "keep",
    });
  });

  it("does not overwrite newer history during failed-setting rollback", () => {
    const original = JSON.stringify(["old"]);
    const newer = JSON.stringify(["newer"]);
    const values = new Map([[HISTORY_KEY, original]]);
    let targetAttempts = 0;
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => {
        if (key === "rootvc.aliases") {
          targetAttempts += 1;
          if (targetAttempts === 2) values.set(HISTORY_KEY, newer);
          throw new Error("target denied");
        }
        values.set(key, String(value));
      }),
    };
    const write = loadHelper();

    expect(() => write(storage, "rootvc.aliases", "candidate")).toThrow(
      "target denied"
    );
    expect(values.get(HISTORY_KEY)).toBe(newer);
    expect(values.has("rootvc.aliases")).toBe(false);
  });

  it.each([
    ["absent", null],
    ["empty", "[]"],
    ["malformed", "not-json"],
    ["non-string entry", '["ping", 3]'],
  ])("preserves the original failure for %s history", (_label, history) => {
    const values = new Map();
    if (history !== null) values.set(HISTORY_KEY, history);
    const original = new Error("target denied");
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn(() => {
        throw original;
      }),
    };
    const write = loadHelper();

    expect(() => write(storage, "setting", "candidate")).toThrow(original);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(values.get(HISTORY_KEY)).toBe(history ?? undefined);
  });

  it.each([
    ["aliases", "rootvc.aliases", JSON.stringify([["p", "ping"]])],
    [
      "environment variables",
      "rootvc.cli.environment.v1",
      JSON.stringify({ version: 1, variables: [["SAVED", "kept"]] }),
    ],
  ])("lets the production terminal persist %s under shared pressure", (_label, key, expected) => {
    const historyEntries = ["ping", "pwd"];
    const history = JSON.stringify(historyEntries);
    const storage = sharedQuotaStorage(expected.length + "keep".length, {
      [HISTORY_KEY]: history,
      sentinel: "keep",
    });
    env = createBrowserEnv();
    Object.defineProperty(env.window, "localStorage", {
      configurable: true,
      value: storage,
    });
    env.loadScripts(["js/browser-storage.js", "js/terminal-ext.js"]);
    const { extend } = env.exportValues(["extend"]);
    const term = {};
    extend(term);

    if (key === "rootvc.aliases") {
      expect(term.defineAlias("p", "ping")).toBe(true);
      expect(term.getAlias("p")).toBe("ping");
    } else {
      expect(term.environment.set("SAVED", "kept")).toEqual({
        ok: true,
        code: "updated",
        message: "",
      });
      expect(term.environment.get("SAVED")).toBe("kept");
    }

    expect(storage.value(key)).toBe(expected);
    expect(storage.value(HISTORY_KEY)).toBeUndefined();
    expect(storage.value("sentinel")).toBe("keep");
    expect(term.history).toEqual(historyEntries);
    expect(term.visitHistory).toEqual([]);
  });

  it("lets the production bookmark store persist under shared pressure", () => {
    const history = JSON.stringify(["ping", "pwd"]);
    const expected = JSON.stringify([["checkpoint", "~"]]);
    const storage = sharedQuotaStorage(expected.length + "keep".length, {
      [HISTORY_KEY]: history,
      sentinel: "keep",
    });
    env = createBrowserEnv();
    env.loadScripts(["js/browser-storage.js", "js/bookmarks.js"]);
    const { createBookmarkStore } = env.exportValues(["createBookmarkStore"]);
    const store = createBookmarkStore(storage);

    expect(store.add("checkpoint", "~")).toEqual({ ok: true });
    expect(store.lookup("checkpoint")).toEqual({ ok: true, path: "~" });
    expect(storage.snapshot()).toEqual({
      sentinel: "keep",
      "rootvc.bookmarks.v1": expected,
    });
  });
});

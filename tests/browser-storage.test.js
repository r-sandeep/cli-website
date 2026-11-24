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
      if (size > limit) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
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
  it.each([
    ["generic error", () => new Error("permission denied")],
    [
      "security error",
      () => new DOMException("storage access denied", "SecurityError"),
    ],
    ["null", () => null],
    ["undefined", () => undefined],
    [
      "quota-like message without quota name",
      () => Object.assign(new Error("quota exceeded"), { code: 22 }),
    ],
  ])(
    "does not inspect history or retry after a non-quota %s",
    (_label, createFailure) => {
      const history = JSON.stringify(["ping", "pwd"]);
      const values = new Map([
        [HISTORY_KEY, history],
        ["rootvc.aliases", JSON.stringify([["old", "pwd"]])],
        ["sentinel", "keep"],
      ]);
      const before = Object.fromEntries(values);
      const failure = createFailure();
      let denyNextTargetWrite = true;
      const storage = {
        getItem: vi.fn((key) => values.get(key) ?? null),
        setItem: vi.fn((key, value) => {
          if (key === "rootvc.aliases" && denyNextTargetWrite) {
            denyNextTargetWrite = false;
            throw failure;
          }
          values.set(key, String(value));
        }),
        removeItem: vi.fn((key) => values.delete(key)),
      };
      const write = loadHelper();

      let caught = Symbol("not thrown");
      try {
        write(storage, "rootvc.aliases", JSON.stringify([["p", "ping"]]));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(failure);
      expect(storage.setItem).toHaveBeenCalledTimes(1);
      expect(storage.getItem).not.toHaveBeenCalled();
      expect(storage.removeItem).not.toHaveBeenCalled();
      expect(Object.fromEntries(values)).toEqual(before);

      const next = JSON.stringify([["p", "ping"]]);
      expect(() => write(storage, "rootvc.aliases", next)).not.toThrow();
      expect(values.get("rootvc.aliases")).toBe(next);
      expect(values.get(HISTORY_KEY)).toBe(history);
      expect(values.get("sentinel")).toBe("keep");
    }
  );

  it.each(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"])(
    "recognizes %s by exception name across realms",
    (name) => {
      const history = JSON.stringify(["ping"]);
      const values = new Map([[HISTORY_KEY, history]]);
      let attempts = 0;
      const storage = {
        getItem: vi.fn((key) => values.get(key) ?? null),
        setItem: vi.fn((key, value) => {
          if (key === "rootvc.aliases" && attempts++ === 0) {
            throw { name, message: "capacity" };
          }
          values.set(key, String(value));
        }),
        removeItem: vi.fn((key) => values.delete(key)),
      };
      const setting = JSON.stringify([["p", "ping"]]);

      loadHelper()(storage, "rootvc.aliases", setting);

      expect(values.get("rootvc.aliases")).toBe(setting);
      expect(values.has(HISTORY_KEY)).toBe(false);
      expect(storage.setItem).toHaveBeenCalledTimes(2);
    }
  );

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

  it("leaves yielded history released after a failed retry and rethrows the original error", () => {
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
      sentinel: "keep",
    });
  });

  it("does not restore stale history after nested recovery consumes a newer write", () => {
    const original = JSON.stringify(["old"]);
    const values = new Map([[HISTORY_KEY, original]]);
    let outerAttempts = 0;
    let innerAttempts = 0;
    let write;
    let historyStore;
    const outerQuota = new DOMException("outer full", "QuotaExceededError");
    const innerQuota = new DOMException("inner full", "QuotaExceededError");
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      removeItem: vi.fn((key) => values.delete(key)),
      setItem: vi.fn((key, value) => {
        if (key === "outer") {
          if (outerAttempts++ === 0) throw outerQuota;
          historyStore.append("newer");
          write(storage, "inner", "kept");
          throw new Error("outer retry denied");
        }
        if (key === "inner" && innerAttempts++ === 0) throw innerQuota;
        values.set(key, String(value));
      }),
    };
    env = createBrowserEnv();
    Object.defineProperty(env.window, "localStorage", {
      configurable: true,
      value: storage,
    });
    env.loadScripts(["js/browser-storage.js", "js/terminal-ext.js"]);
    ({ writeBrowserSetting: write, createHistoryStore: historyStore } =
      env.exportValues(["writeBrowserSetting", "createHistoryStore"]));
    historyStore = historyStore();

    expect(() => write(storage, "outer", "candidate")).toThrow(outerQuota);
    expect(historyStore.snapshot()).toEqual(["old", "newer"]);
    expect(values.get("inner")).toBe("kept");
    expect(values.has(HISTORY_KEY)).toBe(false);

    historyStore.append("after");
    expect(JSON.parse(values.get(HISTORY_KEY))).toEqual(["after"]);
  });

  it("does not restore stale history across independent page realms", () => {
    const original = JSON.stringify(["old"]);
    const values = new Map([[HISTORY_KEY, original]]);
    let outerAttempts = 0;
    let innerAttempts = 0;
    let tabBHistory;
    const outerQuota = new DOMException("outer full", "QuotaExceededError");
    const innerQuota = new DOMException("inner full", "QuotaExceededError");
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      removeItem: vi.fn((key) => values.delete(key)),
      setItem: vi.fn((key, value) => {
        if (key === "outer") {
          if (outerAttempts++ === 0) throw outerQuota;
          tabBHistory.append("newer");
          tabB.writeBrowserSetting(storage, "inner", "kept");
          throw new Error("outer retry denied");
        }
        if (key === "inner" && innerAttempts++ === 0) throw innerQuota;
        values.set(key, String(value));
      }),
    };
    const tabAEnv = createBrowserEnv();
    const tabBEnv = createBrowserEnv();
    Object.defineProperty(tabAEnv.window, "localStorage", {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(tabBEnv.window, "localStorage", {
      configurable: true,
      value: storage,
    });
    tabAEnv.loadScripts(["js/browser-storage.js", "js/terminal-ext.js"]);
    tabBEnv.loadScripts(["js/browser-storage.js", "js/terminal-ext.js"]);
    const tabA = tabAEnv.exportValues(["writeBrowserSetting"]);
    const tabB = tabBEnv.exportValues([
      "writeBrowserSetting",
      "createHistoryStore",
    ]);
    tabBHistory = tabB.createHistoryStore();

    try {
      expect(() =>
        tabA.writeBrowserSetting(storage, "outer", "candidate")
      ).toThrow(outerQuota);
      expect(tabBHistory.snapshot()).toEqual(["old", "newer"]);
      expect(values.get("inner")).toBe("kept");
      expect(values.has(HISTORY_KEY)).toBe(false);

      tabBHistory.append("after");
      expect(JSON.parse(values.get(HISTORY_KEY))).toEqual(["after"]);
    } finally {
      tabAEnv.cleanup();
      tabBEnv.cleanup();
    }
  });

  it("does not overwrite newer history during failed-setting rollback", () => {
    const original = JSON.stringify(["old"]);
    const newer = JSON.stringify(["newer"]);
    const values = new Map([[HISTORY_KEY, original]]);
    let targetAttempts = 0;
    const initialQuota = new DOMException(
      "target exceeds capacity",
      "QuotaExceededError"
    );
    const retryFailure = new Error("target denied after recovery");
    const storage = {
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => {
        if (key === "rootvc.aliases") {
          targetAttempts += 1;
          if (targetAttempts === 1) throw initialQuota;
          values.set(HISTORY_KEY, newer);
          throw retryFailure;
        }
        values.set(key, String(value));
      }),
    };
    const write = loadHelper();

    expect(() => write(storage, "rootvc.aliases", "candidate")).toThrow(
      initialQuota
    );
    expect(targetAttempts).toBe(2);
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

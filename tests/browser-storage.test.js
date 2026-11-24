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
    const limit = setting.length + sentinel.length + "[]".length;
    const storage = sharedQuotaStorage(limit, {
      [HISTORY_KEY]: history,
      sentinel,
    });
    const write = loadHelper();

    if (yields) {
      write(storage, "rootvc.aliases", setting);
      expect(storage.snapshot()).toEqual({
        [HISTORY_KEY]: "[]",
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
});

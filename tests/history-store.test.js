import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const HISTORY_KEY = "rootvc.history.v1";

let env;

function memoryStorage(initial = {}) {
  const values = new Map(
    Object.entries(initial).map(([key, value]) => [key, String(value)])
  );
  return {
    getItem: vi.fn((key) => (values.has(key) ? values.get(key) : null)),
    setItem: vi.fn((key, value) => values.set(key, String(value))),
    value: (key) => values.get(key),
  };
}

function loadHistoryStore(storage = memoryStorage()) {
  env = createBrowserEnv();
  Object.defineProperty(env.window, "localStorage", {
    configurable: true,
    value: storage,
  });
  env.loadScript("js/terminal-ext.js");
  const { createHistoryStore } = env.exportValues(["createHistoryStore"]);
  return { createHistoryStore, storage };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("browser-local history store", () => {
  it("preserves order and duplicates while bounding memory and storage to the newest 200 entries", () => {
    const { createHistoryStore, storage } = loadHistoryStore();
    const store = createHistoryStore();
    const submitted = Array.from({ length: 201 }, (_, index) =>
      index === 80 || index === 81 ? "duplicate" : `command-${index}`
    );
    const boundaries = new Set([1, 199, 200, 201]);

    expect(store.snapshot()).toEqual([]);
    expect(store.append("")).toEqual([]);
    expect(store.append("   ")).toEqual([]);
    expect(storage.value(HISTORY_KEY)).toBeUndefined();

    submitted.forEach((command, index) => {
      store.append(command);
      const count = index + 1;
      if (!boundaries.has(count)) return;

      const expected = submitted.slice(0, count).slice(-200);
      expect(store.snapshot()).toEqual(expected);
      expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(expected);
    });

    const expectedAt201 = submitted.slice(-200);

    const restored = createHistoryStore();
    expect(restored.snapshot()).toEqual(expectedAt201);
    restored.append("after-reload");

    const expectedAfterReload = [...expectedAt201, "after-reload"].slice(-200);
    expect(restored.snapshot()).toEqual(expectedAfterReload);
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(expectedAfterReload);
  });

  it.each([
    ["absent data", undefined],
    ["invalid JSON", "{"],
    ["a non-array value", JSON.stringify({ command: "ping" })],
    ["an array containing a non-string", JSON.stringify(["ping", 7])],
  ])("starts empty for %s and replaces only the history key on append", (_label, payload) => {
    const initial = {
      "rootvc.aliases": "alias-sentinel",
      "rootvc.cli.environment.v1": "environment-sentinel",
      "rootvc.bookmarks.v1": "bookmark-sentinel",
    };
    if (payload !== undefined) initial[HISTORY_KEY] = payload;
    const { createHistoryStore, storage } = loadHistoryStore(memoryStorage(initial));

    const store = createHistoryStore();
    expect(store.snapshot()).toEqual([]);
    store.append("ping");

    expect(store.snapshot()).toEqual(["ping"]);
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(["ping"]);
    expect(storage.value("rootvc.aliases")).toBe("alias-sentinel");
    expect(storage.value("rootvc.cli.environment.v1")).toBe("environment-sentinel");
    expect(storage.value("rootvc.bookmarks.v1")).toBe("bookmark-sentinel");
  });

  it("restores the newest 200 strings from oversized valid data and writes a bounded array", () => {
    const saved = Array.from({ length: 201 }, (_, index) => `saved-${index}`);
    const storage = memoryStorage({
      [HISTORY_KEY]: JSON.stringify(saved),
      "rootvc.aliases": "untouched",
    });
    const { createHistoryStore } = loadHistoryStore(storage);
    const store = createHistoryStore();

    expect(store.snapshot()).toEqual(saved.slice(-200));
    store.append("newest");

    const expected = [...saved, "newest"].slice(-200);
    expect(store.snapshot()).toEqual(expected);
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual(expected);
    expect(storage.value("rootvc.aliases")).toBe("untouched");
  });

  it("keeps bounded in-memory history when the localStorage accessor is denied", () => {
    env = createBrowserEnv();
    Object.defineProperty(env.window, "localStorage", {
      configurable: true,
      get: vi.fn(() => {
        throw new Error("access denied");
      }),
    });
    env.loadScript("js/terminal-ext.js");
    const { createHistoryStore } = env.exportValues(["createHistoryStore"]);

    const store = createHistoryStore();
    expect(() => store.append("first")).not.toThrow();
    expect(() => store.append("second")).not.toThrow();
    expect(store.snapshot()).toEqual(["first", "second"]);
    expect(() => store.append("after-denial")).not.toThrow();
    expect(store.snapshot()).toEqual(["first", "second", "after-denial"]);
  });

  it("keeps bounded in-memory history when reads are denied without attempting a write", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("read denied");
      }),
      setItem: vi.fn(),
    };
    const { createHistoryStore } = loadHistoryStore(storage);
    const store = createHistoryStore();

    expect(() => store.append("first")).not.toThrow();
    expect(() => store.append("second")).not.toThrow();
    expect(store.snapshot()).toEqual(["first", "second"]);
    expect(() => store.append("after-denial")).not.toThrow();
    expect(store.snapshot()).toEqual(["first", "second", "after-denial"]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("retains memory and prior durable data after quota failures without touching other keys", () => {
    const initialHistory = ["saved"];
    const storage = memoryStorage({
      [HISTORY_KEY]: JSON.stringify(initialHistory),
      "rootvc.aliases": "alias-sentinel",
      "rootvc.cli.environment.v1": "environment-sentinel",
      "rootvc.bookmarks.v1": "bookmark-sentinel",
    });
    const { createHistoryStore } = loadHistoryStore(storage);
    const store = createHistoryStore();

    store.append("persisted-before-failure");
    const persistedBeforeFailure = storage.value(HISTORY_KEY);
    storage.setItem.mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(() => store.append("memory-one")).not.toThrow();
    expect(storage.value(HISTORY_KEY)).toBe(persistedBeforeFailure);
    expect(() => store.append("memory-two")).not.toThrow();
    expect(store.snapshot()).toEqual([
      "saved",
      "persisted-before-failure",
      "memory-one",
      "memory-two",
    ]);
    expect(storage.value(HISTORY_KEY)).toBe(persistedBeforeFailure);
    expect(storage.value("rootvc.aliases")).toBe("alias-sentinel");
    expect(storage.value("rootvc.cli.environment.v1")).toBe("environment-sentinel");
    expect(storage.value("rootvc.bookmarks.v1")).toBe("bookmark-sentinel");
  });

  it("merges completed shared-storage writes while keeping each tab view independent", () => {
    const storage = memoryStorage({ [HISTORY_KEY]: JSON.stringify(["initial"]) });
    const { createHistoryStore } = loadHistoryStore(storage);
    const tabA = createHistoryStore();
    const tabB = createHistoryStore();

    tabA.append("A1");
    tabB.append("B1");
    tabA.append("A2");

    expect(tabA.snapshot()).toEqual(["initial", "A1", "A2"]);
    expect(tabB.snapshot()).toEqual(["initial", "B1"]);
    expect(createHistoryStore().snapshot()).toEqual([
      "initial",
      "A1",
      "B1",
      "A2",
    ]);
  });

  it("uses last-completed-write-wins for a genuine overlapping storage write", () => {
    const storage = memoryStorage({ [HISTORY_KEY]: JSON.stringify(["initial"]) });
    const { createHistoryStore } = loadHistoryStore(storage);
    const tabA = createHistoryStore();
    const tabB = createHistoryStore();
    const commit = storage.setItem.getMockImplementation();
    let overlapStarted = false;

    storage.setItem.mockImplementation((key, value) => {
      if (!overlapStarted) {
        overlapStarted = true;
        tabB.append("B-overlap");
      }
      commit(key, value);
    });

    tabA.append("A-overlap");

    expect(tabA.snapshot()).toEqual(["initial", "A-overlap"]);
    expect(tabB.snapshot()).toEqual(["initial", "B-overlap"]);
    expect(JSON.parse(storage.value(HISTORY_KEY))).toEqual([
      "initial",
      "A-overlap",
    ]);
  });
});

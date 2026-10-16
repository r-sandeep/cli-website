import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const STORAGE_KEY = "rootvc.bookmarks.v1";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => (values.has(key) ? values.get(key) : null)),
    setItem: vi.fn((key, value) => values.set(key, value)),
    value: (key = STORAGE_KEY) => values.get(key),
  };
}

let env;

function loadStore(storage = memoryStorage()) {
  env = createBrowserEnv();
  env.loadScripts(["js/bookmarks.js"]);
  const { createBookmarkStore } = env.exportValues(["createBookmarkStore"]);
  return { createBookmarkStore, storage, store: createBookmarkStore(storage) };
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("bookmark store", () => {
  it("validates names and keeps invalid and duplicate additions atomic", () => {
    const { storage, store } = loadStore();

    for (const invalid of ["", "has space", "slash/name", "dot.name", "trim "]) {
      const before = storage.value();
      expect(store.add(invalid, "~/invalid")).toEqual({
        ok: false,
        error: "invalid-name",
      });
      expect(storage.value()).toBe(before);
      expect(store.list()).toEqual({ ok: true, entries: [] });
    }

    expect(store.add("Work_2-home", "~/work")).toEqual({ ok: true });
    expect(store.lookup("Work_2-home")).toEqual({ ok: true, path: "~/work" });

    const committed = storage.value();
    expect(store.add("Work_2-home", "~/replacement")).toEqual({
      ok: false,
      error: "duplicate",
    });
    expect(storage.value()).toBe(committed);
    expect(store.lookup("Work_2-home")).toEqual({ ok: true, path: "~/work" });
  });

  it("round-trips prototype-like names and returns a sorted detached listing", () => {
    const { store } = loadStore();

    expect(store.add("z-last", "/z")).toEqual({ ok: true });
    expect(store.add("__proto__", "/prototype")).toEqual({ ok: true });
    expect(store.add("constructor", "/constructor")).toEqual({ ok: true });
    expect(store.add("A_first", "/a")).toEqual({ ok: true });

    const listed = store.list();
    expect(listed).toEqual({
      ok: true,
      entries: [
        { name: "A_first", path: "/a" },
        { name: "__proto__", path: "/prototype" },
        { name: "constructor", path: "/constructor" },
        { name: "z-last", path: "/z" },
      ],
    });

    listed.entries[1].path = "/changed";
    listed.entries.pop();
    expect(store.lookup("__proto__")).toEqual({ ok: true, path: "/prototype" });
    expect(store.list().entries).toHaveLength(4);
  });

  it("persists removal, leaves absent removal unchanged, and permits re-addition", () => {
    const { storage, store } = loadStore();

    expect(store.add("home", "~")).toEqual({ ok: true });
    expect(store.remove("home")).toEqual({ ok: true });
    expect(store.lookup("home")).toEqual({ ok: false, error: "not-found" });

    const removed = storage.value();
    expect(store.remove("home")).toEqual({ ok: false, error: "not-found" });
    expect(storage.value()).toBe(removed);
    expect(store.list()).toEqual({ ok: true, entries: [] });

    expect(store.add("home", "/new-home")).toEqual({ ok: true });
    expect(store.lookup("home")).toEqual({ ok: true, path: "/new-home" });
  });

  it("enforces 25 entries and reuses capacity only after a committed removal", () => {
    const { storage, store } = loadStore();

    for (let index = 0; index < 25; index++) {
      expect(store.add(`place-${index}`, `/path/${index}`)).toEqual({ ok: true });
    }
    expect(store.list().entries).toHaveLength(25);

    const full = storage.value();
    expect(store.add("twenty-sixth", "/path/26")).toEqual({
      ok: false,
      error: "limit",
    });
    expect(storage.value()).toBe(full);
    expect(store.lookup("twenty-sixth")).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(store.list().entries).toHaveLength(25);

    expect(store.remove("place-5")).toEqual({ ok: true });
    expect(store.add("replacement", "/replacement")).toEqual({ ok: true });
    expect(store.list().entries).toHaveLength(25);
    expect(store.lookup("replacement")).toEqual({
      ok: true,
      path: "/replacement",
    });
  });

  it("reconstructs all committed entries from the same storage", () => {
    const { createBookmarkStore, storage, store } = loadStore();

    expect(store.add("second", "/two")).toEqual({ ok: true });
    expect(store.add("first", "/one")).toEqual({ ok: true });

    const reconstructed = createBookmarkStore(storage);
    expect(reconstructed.list()).toEqual({
      ok: true,
      entries: [
        { name: "first", path: "/one" },
        { name: "second", path: "/two" },
      ],
    });
  });

  it("renames exactly one tuple while preserving paths, order, and reconstruction", () => {
    const serialized = JSON.stringify([
      ["z", "~/exact//path"],
      ["A", "home"],
      ["kept", "bin"],
    ]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { createBookmarkStore, store } = loadStore(storage);

    expect(store.rename("z", "new-name")).toEqual({ ok: true });
    expect(storage.value()).toBe(
      JSON.stringify([
        ["new-name", "~/exact//path"],
        ["A", "home"],
        ["kept", "bin"],
      ])
    );
    expect(store.lookup("z")).toEqual({ ok: false, error: "not-found" });
    expect(store.lookup("new-name")).toEqual({
      ok: true,
      path: "~/exact//path",
    });

    const expected = {
      ok: true,
      entries: [
        { name: "A", path: "home" },
        { name: "kept", path: "bin" },
        { name: "new-name", path: "~/exact//path" },
      ],
    };
    expect(store.list()).toEqual(expected);
    expect(createBookmarkStore(storage).list()).toEqual(expected);
  });

  it("renames at the 25-entry limit without changing capacity bookkeeping", () => {
    const tuples = Array.from({ length: 25 }, (_, index) => [
      `place-${index}`,
      `/path/${index}`,
    ]);
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(tuples) });
    const { createBookmarkStore, store } = loadStore(storage);

    expect(store.rename("place-5", "replacement")).toEqual({ ok: true });
    const renamedTuples = tuples.map((entry, index) =>
      index === 5 ? ["replacement", "/path/5"] : entry
    );
    expect(JSON.parse(storage.value())).toEqual(renamedTuples);
    expect(store.list().entries).toHaveLength(25);
    expect(createBookmarkStore(storage).list()).toEqual(store.list());

    expect(store.add("twenty-sixth", "/path/26")).toEqual({
      ok: false,
      error: "limit",
    });
    expect(JSON.parse(storage.value())).toEqual(renamedTuples);
    expect(store.remove("replacement")).toEqual({ ok: true });
    expect(store.add("fresh", "/fresh")).toEqual({ ok: true });
    expect(store.list().entries).toHaveLength(25);
    expect(store.lookup("fresh")).toEqual({ ok: true, path: "/fresh" });
    expect(store.lookup("place-6")).toEqual({ ok: true, path: "/path/6" });
  });

  it("keeps rename case-sensitive and round-trips every valid name shape", () => {
    const tuples = [
      ["work", "/lower"],
      ["Work", "/upper"],
      ["source-proto", "/prototype"],
      ["source-constructor", "/constructor"],
      ["source-string", "/string"],
      ["source-mixed", "/mixed"],
      ["source-digit", "/digit"],
    ];
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(tuples) });
    const { createBookmarkStore, store } = loadStore(storage);

    expect(store.rename("work", "WORK")).toEqual({ ok: true });
    expect(store.lookup("Work")).toEqual({ ok: true, path: "/upper" });
    expect(store.lookup("work")).toEqual({ ok: false, error: "not-found" });
    expect(store.rename("source-proto", "__proto__")).toEqual({ ok: true });
    expect(store.rename("__proto__", "proto-again")).toEqual({ ok: true });
    expect(store.rename("source-constructor", "constructor")).toEqual({ ok: true });
    expect(store.rename("constructor", "constructor-again")).toEqual({ ok: true });
    expect(store.rename("source-string", "toString")).toEqual({ ok: true });
    expect(store.rename("toString", "string-again")).toEqual({ ok: true });
    expect(store.rename("source-mixed", "Work_2-home")).toEqual({ ok: true });
    expect(store.rename("Work_2-home", "mixed-again")).toEqual({ ok: true });
    expect(store.rename("source-digit", "12345")).toEqual({ ok: true });
    expect(store.rename("12345", "67890")).toEqual({ ok: true });

    const expectedEntries = [
      { name: "67890", path: "/digit" },
      { name: "WORK", path: "/lower" },
      { name: "Work", path: "/upper" },
      { name: "constructor-again", path: "/constructor" },
      { name: "mixed-again", path: "/mixed" },
      { name: "proto-again", path: "/prototype" },
      { name: "string-again", path: "/string" },
    ];
    expect(store.list()).toEqual({ ok: true, entries: expectedEntries });
    expect(createBookmarkStore(storage).list()).toEqual({
      ok: true,
      entries: expectedEntries,
    });
  });

  it("treats an existing same-name rename as a write-free success", () => {
    const tuples = [["home", "~"], ["kept", "bin"]];
    const serialized = JSON.stringify(tuples);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { createBookmarkStore, store } = loadStore(storage);
    storage.setItem.mockImplementation(() => {
      throw new Error("same-name rename must not write");
    });

    expect(store.rename("home", "home")).toEqual({ ok: true });
    expect(store.rename("home", "home")).toEqual({ ok: true });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "home", path: "~" },
        { name: "kept", path: "bin" },
      ],
    });

    expect(store.rename("absent", "absent")).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);

    const fullTuples = Array.from({ length: 25 }, (_, index) => [
      `place-${index}`,
      `/path/${index}`,
    ]);
    const fullSerialized = JSON.stringify(fullTuples);
    const fullStorage = memoryStorage({ [STORAGE_KEY]: fullSerialized });
    const fullStore = createBookmarkStore(fullStorage);
    fullStorage.setItem.mockImplementation(() => {
      throw new Error("full same-name rename must not write");
    });
    expect(fullStore.rename("place-5", "place-5")).toEqual({ ok: true });
    expect(fullStorage.setItem).not.toHaveBeenCalled();
    expect(fullStorage.value()).toBe(fullSerialized);
    expect(fullStore.list().entries).toHaveLength(25);
  });

  it("rejects invalid, missing, and occupied rename operands atomically", () => {
    const tuples = [["old", "home"], ["occupied", "work"]];
    const serialized = JSON.stringify(tuples);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);
    storage.setItem.mockClear();
    const expectedList = {
      ok: true,
      entries: [
        { name: "occupied", path: "work" },
        { name: "old", path: "home" },
      ],
    };

    const invalidValues = ["", " ", "slash/name", "dot.name", "punct!", null, 7];
    for (const invalid of invalidValues) {
      expect(store.rename(invalid, "unused")).toEqual({
        ok: false,
        error: "invalid-name",
      });
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.value()).toBe(serialized);
      expect(store.list()).toEqual(expectedList);

      expect(store.rename("old", invalid)).toEqual({
        ok: false,
        error: "invalid-name",
      });
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.value()).toBe(serialized);
      expect(store.list()).toEqual(expectedList);
    }

    expect(store.rename("missing", "unused")).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.list()).toEqual(expectedList);

    expect(store.rename("old", "occupied")).toEqual({
      ok: false,
      error: "duplicate",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.list()).toEqual(expectedList);
  });

  it("keeps complete memory and persisted state unchanged when rename writes fail", () => {
    const serialized = JSON.stringify([["old", "home"], ["kept", "bin"]]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { createBookmarkStore, store } = loadStore(storage);
    storage.setItem.mockImplementation(() => {
      throw new Error("write denied");
    });

    expect(store.rename("old", "new")).toEqual({ ok: false, error: "storage" });
    expect(storage.value()).toBe(serialized);
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "kept", path: "bin" },
        { name: "old", path: "home" },
      ],
    });
    expect(store.lookup("old")).toEqual({ ok: true, path: "home" });
    expect(store.lookup("new")).toEqual({ ok: false, error: "not-found" });
    expect(createBookmarkStore(storage).list()).toEqual(store.list());
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong payload shape", JSON.stringify({ old: "home" })],
    ["wrong tuple shape", JSON.stringify([["old"]])],
    ["invalid serialized name", JSON.stringify([["bad name", "home"]])],
    ["non-string path", JSON.stringify([["old", 42]])],
    ["duplicate names", JSON.stringify([["old", "one"], ["old", "two"]])],
    [
      "oversized payload",
      JSON.stringify(Array.from({ length: 26 }, (_, index) => [`name-${index}`, `${index}`])),
    ],
  ])("protects %s from rename writes", (_, serialized) => {
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);

    expect(store.rename("old", "new")).toEqual({ ok: false, error: "storage" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.rename("old", "old")).toEqual({ ok: false, error: "storage" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.list()).toEqual({ ok: false, error: "storage" });
  });

  it("protects unreadable and unavailable storage from rename writes", () => {
    const throwingStorage = {
      getItem: vi.fn(() => {
        throw new Error("read denied");
      }),
      setItem: vi.fn(),
    };
    const { createBookmarkStore, store } = loadStore(throwingStorage);

    expect(store.rename("old", "new")).toEqual({ ok: false, error: "storage" });
    expect(store.rename("old", "old")).toEqual({ ok: false, error: "storage" });
    expect(throwingStorage.setItem).not.toHaveBeenCalled();

    const unavailableStorage = { setItem: vi.fn() };
    const unavailable = createBookmarkStore(unavailableStorage);
    expect(unavailable.rename("old", "new")).toEqual({
      ok: false,
      error: "storage",
    });
    expect(unavailable.rename("old", "old")).toEqual({
      ok: false,
      error: "storage",
    });
    expect(unavailableStorage.setItem).not.toHaveBeenCalled();

    Object.defineProperty(env.window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage accessor denied");
      },
    });
    const inaccessible = createBookmarkStore();
    expect(inaccessible.rename("old", "new")).toEqual({
      ok: false,
      error: "storage",
    });
    expect(inaccessible.rename("old", "old")).toEqual({
      ok: false,
      error: "storage",
    });
  });

  it("preserves established operations across repeated and interleaved renames", () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify([["old", "home"], ["kept", "bin"]]),
    });
    const { createBookmarkStore, store } = loadStore(storage);

    expect(store.rename("old", "new")).toEqual({ ok: true });
    expect(JSON.parse(storage.value())).toEqual([["new", "home"], ["kept", "bin"]]);
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "kept", path: "bin" },
        { name: "new", path: "home" },
      ],
    });
    expect(store.add("old", "work")).toEqual({ ok: true });
    expect(JSON.parse(storage.value())).toEqual([
      ["new", "home"],
      ["kept", "bin"],
      ["old", "work"],
    ]);
    expect(store.rename("new", "old")).toEqual({ ok: false, error: "duplicate" });
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "kept", path: "bin" },
        { name: "new", path: "home" },
        { name: "old", path: "work" },
      ],
    });
    expect(store.remove("old")).toEqual({ ok: true });
    expect(JSON.parse(storage.value())).toEqual([["new", "home"], ["kept", "bin"]]);
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "kept", path: "bin" },
        { name: "new", path: "home" },
      ],
    });
    expect(store.rename("new", "old")).toEqual({ ok: true });
    expect(store.lookup("old")).toEqual({ ok: true, path: "home" });
    expect(store.lookup("new")).toEqual({ ok: false, error: "not-found" });
    expect(JSON.parse(storage.value())).toEqual([["old", "home"], ["kept", "bin"]]);

    const expected = {
      ok: true,
      entries: [
        { name: "kept", path: "bin" },
        { name: "old", path: "home" },
      ],
    };
    expect(createBookmarkStore(storage).list()).toEqual(expected);
    const listed = store.list();
    listed.entries[0].path = "changed";
    listed.entries.pop();
    expect(store.list()).toEqual(expected);
  });

  it.each([
    ["malformed JSON", "{"],
    ["wrong payload shape", JSON.stringify({ home: "/home" })],
    ["wrong tuple shape", JSON.stringify([["home"]])],
    ["invalid serialized name", JSON.stringify([["bad name", "/home"]])],
    ["non-string path", JSON.stringify([["home", 42]])],
    ["duplicate names", JSON.stringify([["home", "/one"], ["home", "/two"]])],
    [
      "oversized payload",
      JSON.stringify(Array.from({ length: 26 }, (_, index) => [`name-${index}`, `/path/${index}`])),
    ],
  ])("rejects %s without exposing or replacing partial state", (_, serialized) => {
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);

    expect(store.list()).toEqual({ ok: false, error: "storage" });
    expect(store.lookup("home")).toEqual({ ok: false, error: "storage" });
    expect(store.add("valid", "/valid")).toEqual({ ok: false, error: "storage" });
    expect(storage.value()).toBe(serialized);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("fails closed when reading storage throws", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("read denied");
      }),
      setItem: vi.fn(),
    };
    const { store } = loadStore(storage);

    expect(store.list()).toEqual({ ok: false, error: "storage" });
    expect(store.add("home", "/home")).toEqual({ ok: false, error: "storage" });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("keeps memory and persisted state unchanged when writes throw", () => {
    const serialized = JSON.stringify([["home", "/home"]]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    storage.setItem.mockImplementation(() => {
      throw new Error("write denied");
    });
    const { store } = loadStore(storage);

    expect(store.add("work", "/work")).toEqual({ ok: false, error: "storage" });
    expect(storage.value()).toBe(serialized);
    expect(store.lookup("work")).toEqual({ ok: false, error: "not-found" });
    expect(store.lookup("home")).toEqual({ ok: true, path: "/home" });

    expect(store.remove("home")).toEqual({ ok: false, error: "storage" });
    expect(storage.value()).toBe(serialized);
    expect(store.lookup("home")).toEqual({ ok: true, path: "/home" });
  });
});
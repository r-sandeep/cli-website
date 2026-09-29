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

  it("renames one entry with one complete write and composes with lookup, list, and remove", () => {
    const { storage, store } = loadStore();

    expect(store.add("middle", "/exact/path?value=1#part")).toEqual({ ok: true });
    expect(store.add("other", "/other")).toEqual({ ok: true });
    const before = storage.value();
    storage.setItem.mockClear();

    expect(store.rename("middle", "z-last")).toEqual({ ok: true });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify([
        ["z-last", "/exact/path?value=1#part"],
        ["other", "/other"],
      ])
    );
    expect(storage.value()).not.toBe(before);
    expect(store.lookup("middle")).toEqual({ ok: false, error: "not-found" });
    expect(store.lookup("z-last")).toEqual({
      ok: true,
      path: "/exact/path?value=1#part",
    });
    expect(store.lookup("other")).toEqual({ ok: true, path: "/other" });
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "other", path: "/other" },
        { name: "z-last", path: "/exact/path?value=1#part" },
      ],
    });

    expect(store.remove("z-last")).toEqual({ ok: true });
    expect(store.lookup("z-last")).toEqual({ ok: false, error: "not-found" });
    expect(store.lookup("other")).toEqual({ ok: true, path: "/other" });
  });

  it("rejects invalid, absent, and occupied rename targets without writing", () => {
    const { storage, store } = loadStore();

    expect(store.add("source", "/source")).toEqual({ ok: true });
    expect(store.add("occupied", "/occupied")).toEqual({ ok: true });
    const committed = storage.value();
    const committedList = store.list();
    storage.setItem.mockClear();

    for (const [oldName, newName] of [
      ["bad old", "valid"],
      ["source", "bad/new"],
      ["", "valid"],
      ["source", ""],
      [undefined, "valid"],
      ["source", undefined],
    ]) {
      expect(store.rename(oldName, newName)).toEqual({
        ok: false,
        error: "invalid-name",
      });
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.value()).toBe(committed);
      expect(store.list()).toEqual(committedList);
    }

    expect(store.rename("absent", "new-name")).toEqual({
      ok: false,
      error: "not-found",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(committed);
    expect(store.list()).toEqual(committedList);

    expect(store.rename("source", "occupied")).toEqual({
      ok: false,
      error: "duplicate",
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(committed);
    expect(store.lookup("source")).toEqual({ ok: true, path: "/source" });
    expect(store.lookup("occupied")).toEqual({ ok: true, path: "/occupied" });
    expect(store.list()).toEqual(committedList);
  });

  it("treats a present same-name rename as a no-write success", () => {
    const { storage, store } = loadStore();

    expect(store.add("same", "/same")).toEqual({ ok: true });
    const committed = storage.value();
    const committedList = store.list();
    storage.setItem.mockClear();

    expect(store.rename("same", "same")).toEqual({ ok: true });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(committed);
    expect(store.lookup("same")).toEqual({ ok: true, path: "/same" });
    expect(store.list()).toEqual(committedList);
  });

  it("renames at full capacity without changing count or relaxing the limit", () => {
    const { storage, store } = loadStore();

    for (let index = 0; index < 25; index++) {
      expect(store.add(`place-${index}`, `/path/${index}`)).toEqual({ ok: true });
    }
    storage.setItem.mockClear();

    expect(store.rename("place-5", "renamed-place")).toEqual({ ok: true });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(store.list().entries).toHaveLength(25);
    expect(store.lookup("place-5")).toEqual({ ok: false, error: "not-found" });
    expect(store.lookup("renamed-place")).toEqual({ ok: true, path: "/path/5" });

    const renamed = storage.value();
    expect(store.add("twenty-sixth", "/path/26")).toEqual({
      ok: false,
      error: "limit",
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.value()).toBe(renamed);
    expect(store.list().entries).toHaveLength(25);
  });

  it("keeps the original rename state when its only candidate write throws", () => {
    const serialized = JSON.stringify([
      ["source", "/source"],
      ["other", "/other"],
    ]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    storage.setItem.mockImplementation(() => {
      throw new Error("write denied");
    });
    const { store } = loadStore(storage);

    expect(store.rename("source", "renamed")).toEqual({
      ok: false,
      error: "storage",
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify([
        ["renamed", "/source"],
        ["other", "/other"],
      ])
    );
    expect(storage.value()).toBe(serialized);
    expect(store.lookup("source")).toEqual({ ok: true, path: "/source" });
    expect(store.lookup("renamed")).toEqual({ ok: false, error: "not-found" });
    expect(store.lookup("other")).toEqual({ ok: true, path: "/other" });
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "other", path: "/other" },
        { name: "source", path: "/source" },
      ],
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
    expect(store.rename("home", "renamed")).toEqual({ ok: false, error: "storage" });
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
    expect(store.rename("home", "renamed")).toEqual({ ok: false, error: "storage" });
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
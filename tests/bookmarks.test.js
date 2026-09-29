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
  it("exports compact versioned JSON in code-unit name order without mutation", () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify([
        ["zeta", "/space path/%link%/\\quoted\"/雪"],
        ["Alpha", ""],
        ["__proto__", "https://example.com/a?b=1"],
      ]),
    });
    const { store } = loadStore(storage);
    const persistedBefore = storage.value();
    const stateBefore = store.list();

    expect(store.exportBackup()).toEqual({
      ok: true,
      json: '{"version":1,"bookmarks":[{"name":"Alpha","path":""},{"name":"__proto__","path":"https://example.com/a?b=1"},{"name":"zeta","path":"/space path/%link%/\\\\quoted\\\"/雪"}]}',
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(persistedBefore);
    expect(store.list()).toEqual(stateBefore);
  });

  it("exports an empty store and fails closed for corrupt or inaccessible storage", () => {
    const emptyStorage = memoryStorage();
    const { store: emptyStore } = loadStore(emptyStorage);
    expect(emptyStore.exportBackup()).toEqual({
      ok: true,
      json: '{"version":1,"bookmarks":[]}',
    });
    expect(emptyStorage.setItem).not.toHaveBeenCalled();

    const corruptStorage = memoryStorage({ [STORAGE_KEY]: "not json" });
    const { store: corruptStore } = loadStore(corruptStorage);
    expect(corruptStore.exportBackup()).toEqual({ ok: false, error: "storage" });
    expect(corruptStorage.setItem).not.toHaveBeenCalled();

    const inaccessibleStorage = memoryStorage();
    inaccessibleStorage.getItem.mockImplementation(() => {
      throw new Error("read denied");
    });
    const { store: inaccessibleStore } = loadStore(inaccessibleStorage);
    expect(inaccessibleStore.exportBackup()).toEqual({ ok: false, error: "storage" });
    expect(inaccessibleStorage.setItem).not.toHaveBeenCalled();
  });

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

  it.each([
    ["malformed JSON", "{", "malformed-json"],
    ["non-object document", "[]", "invalid-backup"],
    ["missing version", JSON.stringify({ bookmarks: [] }), "unsupported-version"],
    ["string version", JSON.stringify({ version: "1", bookmarks: [] }), "unsupported-version"],
    ["unsupported version", JSON.stringify({ version: 2, bookmarks: [] }), "unsupported-version"],
    ["missing bookmarks", JSON.stringify({ version: 1 }), "invalid-backup"],
    ["non-array bookmarks", JSON.stringify({ version: 1, bookmarks: {} }), "invalid-backup"],
    ["non-object entry", JSON.stringify({ version: 1, bookmarks: [null] }), "invalid-backup"],
    ["missing name", JSON.stringify({ version: 1, bookmarks: [{ path: "/x" }] }), "invalid-name"],
    ["invalid name", JSON.stringify({ version: 1, bookmarks: [{ name: "bad name", path: "/x" }] }), "invalid-name"],
    ["missing path", JSON.stringify({ version: 1, bookmarks: [{ name: "x" }] }), "invalid-backup"],
    ["non-string path", JSON.stringify({ version: 1, bookmarks: [{ name: "x", path: 1 }] }), "invalid-backup"],
    ["duplicate name", JSON.stringify({ version: 1, bookmarks: [{ name: "x", path: "/x" }, { name: "x", path: "/y" }] }), "duplicate"],
  ])("rejects import state %s before mutation", (_, backup, error) => {
    const serialized = JSON.stringify([["home", "/home"]]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);

    expect(store.importBackup(backup, { mode: "replace" })).toEqual({ ok: false, error });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.list()).toEqual({ ok: true, entries: [{ name: "home", path: "/home" }] });
  });

  it("merges absent and identical entries, rejects conflicts, and ignores unknown fields", () => {
    const serialized = JSON.stringify([["home", "/home"]]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { createBookmarkStore, store } = loadStore(storage);
    const backup = JSON.stringify({
      version: 1,
      future: "ignored",
      bookmarks: [
        { name: "home", path: "/home", note: "ignored" },
        { name: "__proto__", path: "/missing path", extra: true },
        { name: "constructor", path: "/constructor" },
      ],
    });

    expect(store.importBackup(backup, { mode: "merge" })).toEqual({
      ok: true,
      added: 2,
      updated: 0,
      removed: 0,
      unchanged: 1,
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(createBookmarkStore(storage).list()).toEqual({
      ok: true,
      entries: [
        { name: "__proto__", path: "/missing path" },
        { name: "constructor", path: "/constructor" },
        { name: "home", path: "/home" },
      ],
    });

    storage.setItem.mockClear();
    const committed = storage.value();
    expect(store.importBackup(JSON.stringify({
      version: 1,
      bookmarks: [{ name: "home", path: "/different" }],
    }), { mode: "merge" })).toEqual({ ok: false, error: "conflict" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(committed);
    expect(store.lookup("home")).toEqual({ ok: true, path: "/home" });
  });

  it("uses one planner for dry-run and commit counts without preview or no-op writes", () => {
    const serialized = JSON.stringify([["home", "/home"], ["old", "/old"]]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);
    const backup = JSON.stringify({
      version: 1,
      bookmarks: [
        { name: "home", path: "/new-home" },
        { name: "new", path: "/new" },
      ],
    });
    const expected = { ok: true, added: 1, updated: 1, removed: 1, unchanged: 0 };

    expect(store.importBackup(backup, { mode: "replace", dryRun: true })).toEqual(expected);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.lookup("home")).toEqual({ ok: true, path: "/home" });

    expect(store.importBackup(backup, { mode: "replace" })).toEqual(expected);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(store.list()).toEqual({
      ok: true,
      entries: [
        { name: "home", path: "/new-home" },
        { name: "new", path: "/new" },
      ],
    });

    storage.setItem.mockClear();
    expect(store.importBackup(backup, { mode: "replace" })).toEqual({
      ok: true,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 2,
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("atomically reloads non-empty and empty replacements", () => {
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify([["old", "/old"]]) });
    const { createBookmarkStore, store } = loadStore(storage);
    const replacement = JSON.stringify({
      version: 1,
      bookmarks: [{ name: "new", path: "/does/not/exist" }],
    });

    expect(store.importBackup(replacement, { mode: "replace" })).toEqual({
      ok: true,
      added: 1,
      updated: 0,
      removed: 1,
      unchanged: 0,
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(createBookmarkStore(storage).lookup("new")).toEqual({ ok: true, path: "/does/not/exist" });

    storage.setItem.mockClear();
    expect(store.importBackup('{"version":1,"bookmarks":[]}', { mode: "replace" })).toEqual({
      ok: true,
      added: 0,
      updated: 0,
      removed: 1,
      unchanged: 0,
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(createBookmarkStore(storage).list()).toEqual({ ok: true, entries: [] });
  });

  it("rejects resulting overflow before mutation", () => {
    const existing = Array.from({ length: 25 }, (_, index) => [`saved-${index}`, `/saved/${index}`]);
    const serialized = JSON.stringify(existing);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);
    const exactLimitReplace = JSON.stringify({
      version: 1,
      bookmarks: Array.from({ length: 25 }, (_, index) => ({ name: `new-${index}`, path: `/new/${index}` })),
    });
    const merge = JSON.stringify({
      version: 1,
      bookmarks: [{ name: "extra", path: "/extra" }],
    });
    const oversizedReplace = JSON.stringify({
      version: 1,
      bookmarks: Array.from({ length: 26 }, (_, index) => ({ name: `new-${index}`, path: `/new/${index}` })),
    });

    expect(store.importBackup(exactLimitReplace, { mode: "replace", dryRun: true })).toEqual({
      ok: true,
      added: 25,
      updated: 0,
      removed: 25,
      unchanged: 0,
    });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.importBackup(merge, { mode: "merge", dryRun: true })).toEqual({ ok: false, error: "limit" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(store.importBackup(oversizedReplace, { mode: "replace" })).toEqual({ ok: false, error: "limit" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.value()).toBe(serialized);
    expect(store.list().entries).toHaveLength(25);
  });

  it("rolls back a failed import write and fails closed for unreadable current state", () => {
    const serialized = JSON.stringify([["home", "/home"]]);
    const storage = memoryStorage({ [STORAGE_KEY]: serialized });
    const { store } = loadStore(storage);
    storage.setItem.mockImplementation(() => {
      throw new Error("write denied");
    });
    const backup = JSON.stringify({ version: 1, bookmarks: [{ name: "work", path: "/work" }] });

    expect(store.importBackup(backup, { mode: "replace" })).toEqual({ ok: false, error: "storage" });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.value()).toBe(serialized);
    expect(store.lookup("home")).toEqual({ ok: true, path: "/home" });
    expect(store.lookup("work")).toEqual({ ok: false, error: "not-found" });

    const corruptStorage = memoryStorage({ [STORAGE_KEY]: "corrupt" });
    const { store: corruptStore } = loadStore(corruptStorage);
    expect(corruptStore.importBackup(backup, { mode: "replace", dryRun: true })).toEqual({ ok: false, error: "storage" });
    expect(corruptStorage.setItem).not.toHaveBeenCalled();

    const inaccessibleStorage = memoryStorage();
    inaccessibleStorage.getItem.mockImplementation(() => {
      throw new Error("read denied");
    });
    const { store: inaccessibleStore } = loadStore(inaccessibleStorage);
    expect(inaccessibleStore.importBackup(backup, { mode: "merge" })).toEqual({ ok: false, error: "storage" });
    expect(inaccessibleStorage.setItem).not.toHaveBeenCalled();
  });
});
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
        { name: "__proto__", path: "/prototype" },
        { name: "A_first", path: "/a" },
        { name: "constructor", path: "/constructor" },
        { name: "z-last", path: "/z" },
      ],
    });

    listed.entries[0].path = "/changed";
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
});
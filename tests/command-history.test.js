import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;
function loadFactory(globals = {}) {
  env = createBrowserEnv({ globals });
  env.loadScript("js/command-history.js");
  return env.exportValues([
    "COMMAND_HISTORY_LIMIT",
    "createCommandHistoryStore",
    "normalizeCommandHistoryRecord",
  ]);
}
afterEach(() => {
  vi.restoreAllMocks();
  env?.cleanup();
  env = null;
});

describe("command history record validation", () => {
  it("retains exact strings and trims only a valid supported record", () => {
    const { COMMAND_HISTORY_LIMIT, normalizeCommandHistoryRecord } = loadFactory();
    const entries = Array.from({ length: 201 }, (_, index) =>
      index === 200 ? "  Quoted 'Ünicode'  " : `command-${index}`
    );
    expect(COMMAND_HISTORY_LIMIT).toBe(200);
    expect(normalizeCommandHistoryRecord({ id: "history", version: 1, entries }))
      .toEqual(entries.slice(1));
  });

  it("accepts dense empty, duplicate, Unicode, and overlength string arrays", () => {
    const { normalizeCommandHistoryRecord } = loadFactory();
    expect(normalizeCommandHistoryRecord({ id: "history", version: 1, entries: [] }))
      .toEqual([]);
    const dense = ["duplicate", "duplicate", "echo café 🚀"];
    expect(normalizeCommandHistoryRecord({ id: "history", version: 1, entries: dense }))
      .toEqual(dense);
  });

  it.each([
    { length: 3, missing: 0, label: "first" },
    { length: 3, missing: 1, label: "middle" },
    { length: 3, missing: 2, label: "last" },
    { length: 201, missing: 0, label: "evicted prefix" },
  ])("rejects a missing own $label slot before trimming", ({ length, missing }) => {
    const { normalizeCommandHistoryRecord } = loadFactory();
    const entries = Array.from({ length }, (_, index) => `command-${index}`);
    delete entries[missing];
    expect(normalizeCommandHistoryRecord({ id: "history", version: 1, entries }))
      .toBeNull();
  });

  it("rejects a sparse slot even when an inherited string shadows it", () => {
    const { normalizeCommandHistoryRecord } = loadFactory();
    const entries = ["first", "second", "third"];
    delete entries[1];
    Object.setPrototypeOf(entries, { ...Array.prototype, 1: "inherited" });
    expect(entries[1]).toBe("inherited");
    expect(normalizeCommandHistoryRecord({ id: "history", version: 1, entries }))
      .toBeNull();
  });

  it.each([
    null,
    { id: "other", version: 1, entries: [] },
    { id: "history", version: 2, entries: [] },
    { id: "history", version: 1, entries: "not-an-array" },
    { id: "history", version: 1, entries: ["ok", 7] },
  ])("rejects malformed or unsupported records", (record) => {
    const { normalizeCommandHistoryRecord } = loadFactory();
    expect(normalizeCommandHistoryRecord(record)).toBeNull();
  });
});

describe("command history storage settlement", () => {
  it("settles in memory mode when the IndexedDB getter throws", async () => {
    const { createCommandHistoryStore } = loadFactory();
    const options = {};
    Object.defineProperty(options, "indexedDB", {
      get() { throw new Error("private mode"); },
    });
    const store = createCommandHistoryStore(options);
    await expect(store.load()).resolves.toEqual([]);
    await expect(store.append("echo still usable")).resolves.toBeNull();
  });

  it.each(["error", "blocked"])("settles an IndexedDB open %s", async (kind) => {
    const { createCommandHistoryStore } = loadFactory();
    let openCount = 0;
    const indexedDB = {
      open() {
        openCount += 1;
        const request = {};
        queueMicrotask(() => request[`on${kind}`]?.({ preventDefault() {} }));
        return request;
      },
    };
    const store = createCommandHistoryStore({ indexedDB });
    await expect(store.load()).resolves.toEqual([]);
    await expect(store.append("not persisted")).resolves.toBeNull();
    expect(openCount).toBe(1);
  });

  it("closes a successful open that arrives after blocked fallback", async () => {
    const { createCommandHistoryStore } = loadFactory();
    const close = vi.fn();
    const indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.onblocked?.();
          request.result = { close };
          request.onsuccess?.();
        });
        return request;
      },
    };
    await expect(createCommandHistoryStore({ indexedDB }).load()).resolves.toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });
});
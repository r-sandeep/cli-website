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
  vi.useRealTimers();
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
  it("bounds a silent open once and closes a late connection", async () => {
    vi.useFakeTimers();
    const { createCommandHistoryStore } = loadFactory();
    const close = vi.fn();
    let request;
    const indexedDB = {
      open: vi.fn(() => (request = {})),
    };
    const store = createCommandHistoryStore({ indexedDB });
    const load = store.load();

    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    load.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(load).resolves.toEqual([]);
    await expect(store.append("queued")).resolves.toBeNull();
    expect(indexedDB.open).toHaveBeenCalledOnce();

    request.result = { close };
    request.onsuccess();
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts a silent read and ignores late read and completion events", async () => {
    vi.useFakeTimers();
    const { createCommandHistoryStore } = loadFactory();
    const abort = vi.fn();
    const close = vi.fn();
    const getRequest = {};
    const transaction = {
      abort,
      objectStore: () => ({ get: () => getRequest }),
    };
    const database = {
      close,
      objectStoreNames: { contains: () => true },
      transaction: () => transaction,
    };
    const indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess();
        });
        return request;
      },
    };
    const store = createCommandHistoryStore({ indexedDB });
    const load = store.load();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(load).resolves.toEqual([]);
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    getRequest.result = { id: "history", version: 1, entries: ["late"] };
    getRequest.onsuccess();
    transaction.oncomplete();
    await expect(store.append("after-timeout")).resolves.toBeNull();
  });

  it("starts an append deadline only when its serialized operation begins", async () => {
    vi.useFakeTimers();
    const { createCommandHistoryStore } = loadFactory();
    const transactions = [];
    const database = {
      close: vi.fn(),
      objectStoreNames: { contains: () => true },
      transaction() {
        const getRequest = {};
        const put = vi.fn();
        const transaction = {
          abort: vi.fn(),
          objectStore: () => ({ get: () => getRequest, put }),
        };
        transactions.push({ getRequest, put, transaction });
        return transaction;
      },
    };
    const indexedDB = {
      open() {
        const request = {};
        queueMicrotask(() => {
          request.result = database;
          request.onsuccess();
        });
        return request;
      },
    };
    const store = createCommandHistoryStore({ indexedDB });
    const first = store.append("first");
    const second = store.append("second");
    await vi.advanceTimersByTimeAsync(0);
    expect(transactions).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(900);
    transactions[0].getRequest.result = undefined;
    transactions[0].getRequest.onsuccess();
    transactions[0].transaction.oncomplete();
    await expect(first).resolves.toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(transactions).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(transactions[1].transaction.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toBeNull();
    expect(transactions[1].transaction.abort).toHaveBeenCalledOnce();
  });

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
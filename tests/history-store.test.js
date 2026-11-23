import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;
afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

function loadStore(indexedDB, timeoutMs = 20) {
  env = createBrowserEnv({ globals: { indexedDB } });
  env.loadScript("js/history.js");
  return env.exportValues(["createCommandHistoryStore"]).createCommandHistoryStore({
    indexedDB,
    timeoutMs,
  });
}

function callbackFactory(record, { throwOnPut = true } = {}) {
  let durableRecord = structuredClone(record);
  let putCalls = 0;

  const factory = {
    open() {
      const request = {};
      queueMicrotask(() => {
        const database = {
          objectStoreNames: { contains: (name) => name === "state" },
          close() {},
          transaction() {
            let aborted = false;
            const transaction = {
              abort() {
                if (aborted) return;
                aborted = true;
                transaction.onabort?.();
              },
              objectStore() {
                return {
                  get() {
                    const get = {};
                    queueMicrotask(() => {
                      if (aborted) return;
                      get.result = structuredClone(durableRecord);
                      get.onsuccess?.();
                      queueMicrotask(() => {
                        if (!aborted) transaction.oncomplete?.();
                      });
                    });
                    return get;
                  },
                  put(value) {
                    putCalls += 1;
                    if (throwOnPut) {
                      throw new DOMException("quota exhausted", "QuotaExceededError");
                    }
                    durableRecord = structuredClone(value);
                    return {};
                  },
                };
              },
            };
            return transaction;
          },
        };
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    },
  };

  return {
    factory,
    getRecord: () => structuredClone(durableRecord),
    getPutCalls: () => putCalls,
  };
}

describe("command history store memory fallback", () => {
  it("copies snapshots, preserves duplicates and caps memory at the newest 200", async () => {
    const store = loadStore(undefined);
    await store.ready;

    const commands = Array.from({ length: 201 }, (_, index) => `echo ${index}`);
    commands.splice(100, 0, "echo 99");
    for (const command of commands) await store.append(command);

    const expected = commands.slice(-200);
    expect(store.getSnapshot()).toEqual(expected);
    const copy = store.getSnapshot();
    copy.push("mutated by caller");
    expect(store.getSnapshot()).toEqual(expected);
  });

  it("updates memory before unavailable persistence settles and reset is visit-only", async () => {
    let request;
    const blocked = {
      open() {
        request = {};
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    };
    const store = loadStore(blocked);
    const pending = store.append("  echo original syntax  ");

    expect(store.getSnapshot()).toEqual(["echo original syntax"]);
    await expect(pending).resolves.toBe(false);
    store.resetVisit();
    expect(store.getSnapshot()).toEqual([]);
    await expect(store.append("echo after reset")).resolves.toBe(false);
    expect(store.getSnapshot()).toEqual(["echo after reset"]);
  });

  it("settles throwing and timed-out storage without accepting invalid entries", async () => {
    const throwing = loadStore({
      open() {
        throw new DOMException("denied", "SecurityError");
      },
    });
    await expect(throwing.ready).resolves.toBeUndefined();
    await expect(throwing.append("echo kept")).resolves.toBe(false);
    expect(throwing.getSnapshot()).toEqual(["echo kept"]);
    env.cleanup();
    env = null;

    const timedOut = loadStore({ open: () => ({}) }, 1);
    await expect(timedOut.ready).resolves.toBeUndefined();
    await expect(timedOut.append("echo later")).resolves.toBe(false);
    expect(timedOut.getSnapshot()).toEqual(["echo later"]);
    await expect(timedOut.append("   ")).resolves.toBe(false);
    await expect(timedOut.append(null)).resolves.toBe(false);
    expect(timedOut.getSnapshot()).toEqual(["echo later"]);
  });

  it("contains synchronous append put exceptions raised inside request callbacks", async () => {
    const fixture = callbackFactory({ version: 1, entries: ["ping"] });
    const store = loadStore(fixture.factory);
    await store.ready;

    await expect(store.append("echo accepted")).resolves.toBe(false);
    await expect(store.append("echo next")).resolves.toBe(false);

    expect(store.getSnapshot()).toEqual(["ping", "echo accepted", "echo next"]);
    expect(fixture.getRecord()).toEqual({ version: 1, entries: ["ping"] });
    expect(fixture.getPutCalls()).toBe(1);
  });

  it("keeps the capped restore when normalization put throws in its callback", async () => {
    const saved = Array.from({ length: 201 }, (_, index) => `saved ${index}`);
    const original = { version: 1, entries: saved };
    const fixture = callbackFactory(original);
    const store = loadStore(fixture.factory);

    await expect(store.ready).resolves.toBeUndefined();

    expect(store.getSnapshot()).toEqual(saved.slice(-200));
    expect(fixture.getRecord()).toEqual(original);
    expect(fixture.getPutCalls()).toBe(1);
    store.resetVisit();
    expect(store.getSnapshot()).toEqual([]);
    await expect(store.append("echo after reset")).resolves.toBe(false);
    expect(store.getSnapshot()).toEqual(["echo after reset"]);
  });
});

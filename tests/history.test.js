import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const STORAGE_KEY = "rootvc.history";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key) => (values.has(key) ? values.get(key) : null)),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    value: (key) => values.get(key),
  };
  return storage;
}

let env;

function loadStore(storage) {
  env = createBrowserEnv();
  env.loadScripts(["js/history.js"]);
  const { createHistoryStore } = env.exportValues(["createHistoryStore"]);
  return { createHistoryStore, store: createHistoryStore(storage) };
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("history store", () => {
  it("hydrates without writing, keeps newest 1,000 raw strings, and preserves duplicates", () => {
    const syntaxSamples = [
      "  echo Mixed Case  ",
      "echo 'quoted value'",
      "echo $NAME ${NAME}",
      "alias-name",
      "echo source | wc -l",
      "duplicate",
      "duplicate",
    ];
    const seeded = Array.from({ length: 995 }, (_, index) => `command-${index}`).concat(
      syntaxSamples
    );
    expect(seeded).toHaveLength(1002);
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(seeded) });
    const { createHistoryStore, store } = loadStore(storage);
    const expectedHydrated = seeded.slice(-1000);

    expect(store.entries()).toEqual(expectedHydrated);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();

    const detached = store.entries();
    detached.pop();
    expect(store.entries()).toEqual(expectedHydrated);

    expect(store.append("duplicate")).toEqual({
      ok: true,
      durable: true,
      error: null,
      added: true,
    });
    const expectedSaved = [...expectedHydrated, "duplicate"].slice(-1000);
    expect(store.entries()).toEqual(expectedSaved);
    expect(JSON.parse(storage.value(STORAGE_KEY))).toEqual(expectedSaved);

    expect(store.append(" \t ")).toEqual({
      ok: true,
      durable: true,
      error: null,
      added: false,
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(createHistoryStore(storage).entries()).toEqual(expectedSaved);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["object payload", JSON.stringify({ entries: ["saved"] })],
    ["non-string entry", JSON.stringify(["saved", 7])],
    ["blank entry", JSON.stringify(["saved", " \t "])],
  ])("quarantines %s until an explicit clear succeeds", (_, payload) => {
    const storage = memoryStorage({ [STORAGE_KEY]: payload, unrelated: "sentinel" });
    const { createHistoryStore, store } = loadStore(storage);

    expect(store.status()).toEqual({ durable: false, error: "read", quarantined: true });
    expect(store.append("first session command")).toMatchObject({
      durable: false,
      error: "read",
      added: true,
    });
    expect(store.append("second session command")).toMatchObject({
      durable: false,
      error: "read",
      added: true,
    });
    expect(store.entries()).toEqual(["first session command", "second session command"]);
    expect(storage.value(STORAGE_KEY)).toBe(payload);
    expect(storage.setItem).not.toHaveBeenCalled();

    storage.removeItem.mockImplementationOnce(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(store.clear()).toEqual({ ok: true, durable: false, error: "clear" });
    expect(store.entries()).toEqual([]);
    expect(storage.value(STORAGE_KEY)).toBe(payload);
    expect(store.append("after failed clear")).toMatchObject({
      durable: false,
      error: "clear",
      added: true,
    });
    expect(storage.setItem).not.toHaveBeenCalled();

    expect(store.clear()).toEqual({ ok: true, durable: true, error: null });
    expect(storage.value(STORAGE_KEY)).toBeUndefined();
    expect(storage.value("unrelated")).toBe("sentinel");
    expect(store.append("after recovery")).toMatchObject({ durable: true, added: true });
    expect(createHistoryStore(storage).entries()).toEqual(["after recovery"]);
  });

  it("survives unavailable localStorage access and recovers through explicit clear", () => {
    env = createBrowserEnv();
    const getter = vi
      .spyOn(env.window, "localStorage", "get")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    env.loadScripts(["js/history.js"]);
    const { createHistoryStore } = env.exportValues(["createHistoryStore"]);
    const store = createHistoryStore();

    expect(store.status()).toEqual({
      durable: false,
      error: "unavailable",
      quarantined: true,
    });
    expect(store.append("session one")).toMatchObject({
      durable: false,
      error: "unavailable",
      added: true,
    });
    expect(store.entries()).toEqual(["session one"]);
    expect(store.clear()).toEqual({ ok: true, durable: false, error: "clear" });
    expect(store.entries()).toEqual([]);

    getter.mockRestore();
    expect(store.clear()).toEqual({ ok: true, durable: true, error: null });
    expect(store.append("persisted after recovery")).toMatchObject({
      durable: true,
      added: true,
    });
    expect(JSON.parse(env.window.localStorage.getItem(STORAGE_KEY))).toEqual([
      "persisted after recovery",
    ]);
  });

  it("keeps session history and quarantines valid saved bytes after a read failure", () => {
    const saved = JSON.stringify(["saved command"]);
    const storage = memoryStorage({ [STORAGE_KEY]: saved });
    storage.getItem.mockImplementation(() => {
      throw new DOMException("read failed", "SecurityError");
    });
    const { store } = loadStore(storage);

    expect(store.append("session command")).toMatchObject({
      durable: false,
      error: "read",
      added: true,
    });
    expect(store.entries()).toEqual(["session command"]);
    expect(storage.value(STORAGE_KEY)).toBe(saved);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("retains memory on failed writes and reports later write recovery", () => {
    const storage = memoryStorage({ [STORAGE_KEY]: JSON.stringify(["saved"]) });
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { store } = loadStore(storage);

    expect(store.append("memory only")).toEqual({
      ok: true,
      durable: false,
      error: "write",
      added: true,
    });
    expect(store.entries()).toEqual(["saved", "memory only"]);
    expect(JSON.parse(storage.value(STORAGE_KEY))).toEqual(["saved"]);

    expect(store.append("recovered write")).toMatchObject({ durable: true, error: null });
    expect(JSON.parse(storage.value(STORAGE_KEY))).toEqual([
      "saved",
      "memory only",
      "recovered write",
    ]);
  });

  it("failed clear empties memory, reports non-durability, and blocks later writes", () => {
    const saved = JSON.stringify(["saved"]);
    const storage = memoryStorage({ [STORAGE_KEY]: saved });
    storage.removeItem.mockImplementation(() => {
      throw new DOMException("remove failed", "SecurityError");
    });
    const { store } = loadStore(storage);

    expect(store.clear()).toEqual({ ok: true, durable: false, error: "clear" });
    expect(store.entries()).toEqual([]);
    expect(storage.value(STORAGE_KEY)).toBe(saved);
    expect(store.append("session after clear failure")).toMatchObject({
      durable: false,
      error: "clear",
      added: true,
    });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("touches only rootvc.history across retention, failures, and recovery", () => {
    const unrelated = {
      "rootvc.bookmarks.v1": '[["home","~"]]',
      "rootvc.aliases": '{"ll":"ls"}',
      "rootvc.environment": '{"NAME":"root"}',
      arbitrary: "exact sentinel bytes",
    };
    const seeded = Array.from({ length: 1000 }, (_, index) => `line-${index}`);
    const storage = memoryStorage({
      ...unrelated,
      [STORAGE_KEY]: JSON.stringify(seeded),
    });
    const { store } = loadStore(storage);

    expect(store.append("line-1000")).toMatchObject({ durable: true });
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(store.append("memory-only")).toMatchObject({ durable: false, error: "write" });
    storage.removeItem.mockImplementationOnce(() => {
      throw new DOMException("remove failed", "SecurityError");
    });
    expect(store.clear()).toMatchObject({ durable: false, error: "clear" });
    expect(store.clear()).toMatchObject({ durable: true, error: null });

    for (const [key, value] of Object.entries(unrelated)) {
      expect(storage.value(key)).toBe(value);
    }
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.setItem.mock.calls.every(([key]) => key === STORAGE_KEY)).toBe(true);
    expect(storage.removeItem.mock.calls.every(([key]) => key === STORAGE_KEY)).toBe(true);
  });
});

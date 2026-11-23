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
});

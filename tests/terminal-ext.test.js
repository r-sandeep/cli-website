import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadTerminalExt(globals = {}) {
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      colorText: (text) => text,
      commands: { help: vi.fn() },
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      jobs: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      ...globals,
    },
  });
  env.loadScripts(["js/terminal-ext.js"]);
  return env.exportValues(["extend"]);
}

function createTerm(overrides = {}) {
  const term = {
    VERSION: 4,
    _core: { buffer: { x: 0 } },
    cols: 80,
    command: vi.fn(() => 0),
    currentLine: "",
    focus: vi.fn(),
    history: [],
    loadAddon: vi.fn(),
    open: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };

  return Object.assign(term, overrides);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal-ext", () => {
  const environmentStorageKey = "rootvc.cli.environment.v1";

  it("keeps environment state private and returns sorted defensive copies", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);

    expect(term.environment.set("ZED", "last")).toMatchObject({ ok: true });
    expect(term.environment.set("_EMPTY", "")).toMatchObject({ ok: true });
    expect(term.environment.entries()).toEqual([
      ["_EMPTY", ""],
      ["ZED", "last"],
    ]);

    const snapshot = term.environment.snapshot();
    snapshot.set("INTRUDER", "mutated copy");
    const entries = term.environment.entries();
    entries[0][1] = "mutated entry";

    expect(term.environment.snapshot()).toEqual(
      new env.window.Map([
        ["ZED", "last"],
        ["_EMPTY", ""],
      ])
    );
    expect(env.window.environmentVariables).toBeUndefined();
    expect(Object.isFrozen(term.environment)).toBe(true);
  });

  it("rejects invalid names without changing memory or persisted state", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("VALID_1", "before");
    const persistedBefore = env.window.localStorage.getItem(environmentStorageKey);

    for (const invalidName of ["", "1BAD", "BAD-NAME", "HAS SPACE", "é"] ) {
      const snapshotBefore = [...term.environment.snapshot()];
      const result = term.environment.set(invalidName, "after");

      expect(result).toMatchObject({ ok: false, code: "invalid" });
      expect(result.message).toContain("Invalid environment variable name");
      expect([...term.environment.snapshot()]).toEqual(snapshotBefore);
      expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
        persistedBefore
      );
    }
  });

  it("supports every mutation transition including overwrite and unset at capacity", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);

    for (let index = 0; index < 50; index += 1) {
      expect(term.environment.set(`VAR_${index}`, String(index))).toMatchObject({
        ok: true,
      });
    }
    expect(term.environment.snapshot().size).toBe(50);

    expect(term.environment.set("VAR_0", "overwritten")).toMatchObject({
      ok: true,
    });
    expect(term.environment.get("VAR_0")).toBe("overwritten");

    const persistedAtCapacity = env.window.localStorage.getItem(
      environmentStorageKey
    );
    const rejected = term.environment.set("ONE_TOO_MANY", "nope");
    expect(rejected).toMatchObject({ ok: false, code: "capacity" });
    expect(rejected.message).toContain("50");
    expect(term.environment.get("ONE_TOO_MANY")).toBeUndefined();
    expect(term.environment.snapshot().size).toBe(50);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      persistedAtCapacity
    );

    expect(term.environment.unset("VAR_1")).toMatchObject({
      ok: true,
      code: "updated",
    });
    expect(term.environment.get("VAR_1")).toBeUndefined();
    const afterPresentUnset = env.window.localStorage.getItem(environmentStorageKey);

    expect(term.environment.unset("ABSENT")).toEqual({
      ok: true,
      code: "absent",
      message: "",
    });
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      afterPresentUnset
    );
    expect(term.environment.set("REFILLED", "")).toMatchObject({ ok: true });
    expect(term.environment.get("REFILLED")).toBe("");
    expect(term.environment.snapshot().size).toBe(50);
  });

  it("hydrates a replacement terminal from the persisted versioned payload", () => {
    const { extend } = loadTerminalExt();
    const first = createTerm();
    extend(first);
    first.environment.set("ZED", "last");
    first.environment.set("ALPHA", "first");
    first.environment.set("EMPTY", "");
    const persisted = env.window.localStorage.getItem(environmentStorageKey);

    const replacement = createTerm();
    extend(replacement);

    expect(replacement.environment.entries()).toEqual([
      ["ALPHA", "first"],
      ["EMPTY", ""],
      ["ZED", "last"],
    ]);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(persisted);

    first.environment.set("LATER", "only in first live map");
    expect(replacement.environment.get("LATER")).toBeUndefined();
  });

  it.each([
    ["invalid JSON", "{"],
    ["unsupported version", JSON.stringify({ version: 2, variables: [] })],
    ["wrong shape", JSON.stringify({ version: 1, variables: {} })],
    [
      "extra field",
      JSON.stringify({ version: 1, variables: [], extra: "data" }),
    ],
    [
      "prototype-sensitive field",
      '{"version":1,"variables":[],"__proto__":{"POLLUTED":"yes"}}',
    ],
    ["invalid name", JSON.stringify({ version: 1, variables: [["1BAD", "x"]] })],
    ["non-string value", JSON.stringify({ version: 1, variables: [["GOOD", 1]] })],
    [
      "duplicate name",
      JSON.stringify({ version: 1, variables: [["GOOD", "1"], ["GOOD", "2"]] }),
    ],
    [
      "over capacity",
      JSON.stringify({
        version: 1,
        variables: Array.from({ length: 51 }, (_, index) => [
          `VAR_${index}`,
          String(index),
        ]),
      }),
    ],
  ])("ignores a %s persisted payload", (_description, serialized) => {
    const { extend } = loadTerminalExt();
    env.window.localStorage.setItem(environmentStorageKey, serialized);
    const term = createTerm();

    expect(() => extend(term)).not.toThrow();
    expect(term.environment.entries()).toEqual([]);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(serialized);
  });

  it("treats inaccessible storage as empty without throwing", () => {
    const { extend } = loadTerminalExt();
    vi.spyOn(env.window.Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const term = createTerm();

    expect(() => extend(term)).not.toThrow();
    expect(term.environment.entries()).toEqual([]);
  });

  it("leaves live and persisted state unchanged when persistence fails", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("SAFE", "persisted");
    const persistedBefore = env.window.localStorage.getItem(environmentStorageKey);
    vi.spyOn(env.window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const failedSet = term.environment.set("NEW", "not committed");
    expect(failedSet).toMatchObject({ ok: false, code: "storage" });
    expect(failedSet.message).toContain("could not be saved");
    expect(term.environment.entries()).toEqual([["SAFE", "persisted"]]);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      persistedBefore
    );

    const failedUnset = term.environment.unset("SAFE");
    expect(failedUnset).toMatchObject({ ok: false, code: "storage" });
    expect(term.environment.entries()).toEqual([["SAFE", "persisted"]]);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      persistedBefore
    );
  });

  it("preserves environment state across init, shell reset, and resize replay", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("KEEP", "value");

    term.init();
    expect(term.environment.entries()).toEqual([["KEEP", "value"]]);

    term.init(term.user);
    expect(term.environment.entries()).toEqual([["KEEP", "value"]]);

    term.runDeepLink = vi.fn();
    term.resizeListener();
    expect(term.environment.entries()).toEqual([["KEEP", "value"]]);
  });

  it("normalizes preload-only aliases before resolving assets", async () => {
    const { extend } = loadTerminalExt({
      getASCIIArtIdForCommand: vi.fn(() => "lee"),
      getPreloadFileForCommand: vi.fn(() => "README.md"),
    });
    const term = createTerm();

    extend(term);
    await term.preloadCommandAssets("open README.md");

    expect(term.normalizeCommandForPreload("open", ["README.md"])).toEqual({
      args: ["README.md"],
      cmd: "cat",
    });
    expect(term.normalizeCommandForPreload("open", ["welcome.htm"])).toEqual({
      args: ["welcome.htm"],
      cmd: "open",
    });
    expect(env.window.getASCIIArtIdForCommand).toHaveBeenCalledWith("cat", [
      "README.md",
    ]);
    expect(env.window.getPreloadFileForCommand).toHaveBeenCalledWith("cat", [
      "README.md",
    ]);
    expect(env.window.ensureASCIIArt).toHaveBeenCalledWith("lee");
    expect(env.window.ensureFileLoaded).toHaveBeenCalledWith("README.md");
  });

  it("waits for asset preloading before dispatching a command", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    const order = [];

    extend(term);
    term.preloadCommandAssets = vi.fn(async () => {
      order.push("preload");
    });
    term.command = vi.fn(() => {
      order.push("command");
      return 0;
    });

    await term.executeCommandLine("help");

    expect(order).toEqual(["preload", "command"]);
    expect(term.history).toEqual(["help"]);
    expect(env.window.dataLayer).toEqual([
      { args: "", command: "help", event: "commandSent" },
    ]);
    expect(term.busy).toBe(false);
    expect(term.command).toHaveBeenCalledWith("help");
  });

  it("routes deep links through executeCommandLine without double prompts", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    term.deepLink = "whois lee";
    term.executeCommandLine = vi.fn(() => Promise.resolve());
    term.runDeepLink();

    expect(term.executeCommandLine).toHaveBeenCalledWith("whois lee", {
      addToHistory: false,
      promptAfter: false,
      showLeadingNewline: false,
      // Deep links are the only way to address a specific company or person
      // now, and a fragment fires no pageview of its own, so these arrivals
      // would otherwise be invisible in analytics.
      trackAnalytics: true,
    });
  });

  it("does not re-count a deep link when a resize replays it", () => {
    // xterm clears its buffer on resize, so resizeListener reruns the deep link
    // to redraw the output. That is the same visit — counting it again inflates
    // every deep-link arrival by one per resize, and mobile browsers fire
    // resize just from showing and hiding the address bar.
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    term.deepLink = "whois lee";
    term.executeCommandLine = vi.fn(() => Promise.resolve());
    term.runDeepLink({ replay: true });

    expect(term.executeCommandLine).toHaveBeenCalledWith(
      "whois lee",
      expect.objectContaining({ trackAnalytics: false })
    );
  });

  it.each([
    ["#jobs", "jobs"],
    ["#whois-root", "whois root"],
    ["#tldr-chargelab", "tldr chargelab"],
    // The one that used to break: splitting on every hyphen turned a
    // hyphenated slug into two arguments, so the company's own deep link
    // missed. Only the first hyphen separates command from argument.
    ["#tldr-vibe-robotics", "tldr vibe-robotics"],
    ["", ""],
  ])("parses %s into the command %s", (hash, expected) => {
    const { extend } = loadTerminalExt();
    env.window.location.hash = hash;
    const term = createTerm();

    extend(term);

    expect(term.deepLink).toBe(expected);
  });

  it("prints cached art immediately and falls back to loading on cache miss", () => {
    const { extend } = loadTerminalExt({
      getArt: vi.fn()
        .mockReturnValueOnce("ASCII")
        .mockReturnValueOnce(""),
    });
    const term = createTerm();

    extend(term);
    term.printArt("lee");
    term.printArt("rootvc-square");

    expect(term.writeln).toHaveBeenCalledWith("\r\nASCII\r\n");
    expect(env.window.ensureASCIIArt).toHaveBeenCalledWith("rootvc-square");
  });
});

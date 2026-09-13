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
  env.loadScripts(["js/pipeline.js", "js/terminal-ext.js"]);
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

function installApplyCommand(term, { inputs, response }) {
  const inputValues = [...inputs];
  term.collectInput = vi.fn(async (question) => {
    term.write(`INPUT UI: ${question}`);
    return inputValues.shift();
  });
  env.window.term = term;
  env.window.jobs = { 1: ["Platform Engineer"] };
  env.window.firm = { blurb: "", email: "hello@example.com" };
  env.window.team = {};
  env.window.help = {};
  env.window.portfolio = {};
  env.window.fetch = vi.fn().mockResolvedValue(
    response || { ok: true, json: vi.fn().mockResolvedValue({}) }
  );
  env.loadScript("config/commands.js");
  return env.window.fetch;
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
    term.history = ["historical mutation"];
    term.command = vi.fn(() => term.environment.set("KEEP", "replayed"));
    const persistedBeforeResize = env.window.localStorage.getItem(
      environmentStorageKey
    );
    term.resizeListener();
    expect(term.environment.entries()).toEqual([["KEEP", "value"]]);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      persistedBeforeResize
    );
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
    term.dispatchCommand = vi.fn(() => {
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
    expect(term.dispatchCommand).toHaveBeenCalledWith("help", []);
  });

  it("expands every recognized argument reference once without changing token boundaries", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("NAME", "hello world");
    term.environment.set("EMPTY", "");
    term.environment.set("DOLLAR", "$NAME");

    const prepared = term.prepareCommandLine(
      "EcHo $NAME ${NAME} $MISSING pre$NAME${EMPTY}post $DOLLAR \\$NAME path\\keep $9 ${BAD-NAME} cash$"
    );

    expect(prepared.cmd).toBe("echo");
    expect(prepared.args).toEqual([
      "hello world",
      "hello world",
      "",
      "prehello worldpost",
      "$NAME",
      "$NAME",
      String.raw`path\keep`,
      "$9",
      "${BAD-NAME}",
      "cash$",
    ]);
    expect(term.prepareCommandLine("$NAME $NAME")).toMatchObject({
      cmd: "$name",
      args: ["hello world"],
    });
  });

  it("captures one prepared vector before preload while retaining raw history and analytics", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("NAME", "before");
    let releasePreload;
    const preloadPending = new Promise((resolve) => {
      releasePreload = resolve;
    });
    let preloadedArgs;
    term.preloadCommandAssets = vi.fn((_cmd, args) => {
      preloadedArgs = args;
      return preloadPending;
    });
    term.dispatchCommand = vi.fn();

    const execution = term.executeCommandLine("EcHo $NAME");
    expect(term.preloadCommandAssets).toHaveBeenCalledWith("echo", ["before"]);
    term.environment.set("NAME", "after");
    releasePreload();
    await execution;

    expect(term.dispatchCommand).toHaveBeenCalledWith("echo", ["before"]);
    expect(term.dispatchCommand.mock.calls[0][1]).toBe(preloadedArgs);
    expect(term.history).toEqual(["EcHo $NAME"]);
    expect(env.window.dataLayer).toEqual([
      { args: "$NAME", command: "echo", event: "commandSent" },
    ]);
  });

  it("completes one interactive environment command lifecycle without disturbing the prompt", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("NAME", "expanded value");
    term.preloadCommandAssets = vi.fn(async () => {});
    term.dispatchCommand = vi.fn();
    term.prompt = vi.fn();
    term.clearCurrentLine = vi.fn();

    await term.executeCommandLine("echo $NAME");

    expect(term.history).toEqual(["echo $NAME"]);
    expect(term.preloadCommandAssets).toHaveBeenCalledTimes(1);
    expect(term.preloadCommandAssets).toHaveBeenCalledWith("echo", [
      "expanded value",
    ]);
    expect(term.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(term.dispatchCommand).toHaveBeenCalledWith("echo", [
      "expanded value",
    ]);
    expect(term.prompt).toHaveBeenCalledTimes(1);
    expect(term.clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(term.clearCurrentLine).toHaveBeenCalledWith(true);
    expect(term.busy).toBe(false);
  });

  it("persists both sides of a full-store reject, unset, and refill transition", () => {
    const { extend } = loadTerminalExt();
    const fullEntries = Array.from({ length: 50 }, (_, index) => [
      `V${index}`,
      String(index),
    ]);
    env.window.localStorage.setItem(
      environmentStorageKey,
      JSON.stringify({ version: 1, variables: fullEntries })
    );

    const fullReload = createTerm();
    extend(fullReload);
    const persistedAtCapacity = env.window.localStorage.getItem(
      environmentStorageKey
    );
    expect(fullReload.environment.set("OVER", "rejected")).toMatchObject({
      ok: false,
      code: "capacity",
    });
    expect(fullReload.environment.snapshot().size).toBe(50);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      persistedAtCapacity
    );

    expect(fullReload.environment.unset("V0")).toMatchObject({ ok: true });
    const afterUnsetReload = createTerm();
    extend(afterUnsetReload);
    expect(afterUnsetReload.environment.snapshot().size).toBe(49);
    expect(afterUnsetReload.environment.get("V0")).toBeUndefined();

    expect(afterUnsetReload.environment.set("REFILLED", "ready")).toMatchObject({
      ok: true,
    });
    const afterRefillReload = createTerm();
    extend(afterRefillReload);
    expect(afterRefillReload.environment.snapshot().size).toBe(50);
    expect(afterRefillReload.environment.get("REFILLED")).toBe("ready");
    expect(afterRefillReload.environment.get("OVER")).toBeUndefined();
  });

  it("replays environment history for output without changing active or persisted state", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.environment.set("ACTIVE", "later value");
    term.history = [
      "export TEMP=one",
      "export TEMP=two",
      "env",
      "unset TEMP",
      "env",
    ];
    term.runDeepLink = vi.fn();
    env.window.commands.export = (args) => {
      const assignment = args[0];
      const split = assignment.indexOf("=");
      term.environment.set(assignment.slice(0, split), assignment.slice(split + 1));
    };
    env.window.commands.env = () => {
      for (const [name, value] of term.environment.entries()) {
        term.stylePrint(`${name}=${value}`);
      }
    };
    env.window.commands.unset = (args) => term.environment.unset(args[0]);
    const persistedBefore = env.window.localStorage.getItem(environmentStorageKey);

    term.resizeListener();

    expect(term.writeln).toHaveBeenCalledWith("ACTIVE=later value");
    expect(term.writeln).toHaveBeenCalledWith("TEMP=two");
    expect(term.environment.entries()).toEqual([["ACTIVE", "later value"]]);
    expect(env.window.localStorage.getItem(environmentStorageKey)).toBe(
      persistedBefore
    );
  });

  it("runs a producer once and applies ANSI-aware pipeline stages left to right", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    const producer = vi.fn(async (line) => {
      expect(line).toBe("fake source");
      term.write("\x1b[31mAlpha\x1b[0m\r\n");
      term.writeln("beta");
      term.writeln("no match");
      term.writeln("aardvark");
      return 0;
    });
    term.command = producer;
    term.preloadCommandAssets = vi.fn(() => Promise.resolve());
    const prompt = vi.spyOn(term, "prompt");
    const clearCurrentLine = vi.spyOn(term, "clearCurrentLine");

    await term.executeCommandLine("fake source | grep -in a | head 3");

    expect(term.preloadCommandAssets).toHaveBeenCalledOnce();
    expect(term.preloadCommandAssets).toHaveBeenCalledWith("fake source");
    expect(producer).toHaveBeenCalledOnce();
    expect(term.history).toEqual(["fake source | grep -in a | head 3"]);
    expect(term.writeln).toHaveBeenCalledWith("1:\x1b[31mAlpha\x1b[0m");
    expect(term.writeln).toHaveBeenCalledWith("2:beta");
    expect(term.writeln).toHaveBeenCalledWith("3:no match");
    expect(term.writeln).not.toHaveBeenCalledWith("4:aardvark");
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(clearCurrentLine).toHaveBeenCalledOnce();
    expect(term.scrollToBottom).toHaveBeenCalled();
    expect(term.busy).toBe(false);
    expect(env.window.dataLayer).toEqual([
      {
        args: "source | grep -in a | head 3",
        command: "fake",
        event: "commandSent",
      },
    ]);
  });

  it("prints no transformed records when a pipeline producer emits no output", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    const producer = vi.fn(() => 0);
    term.command = producer;
    term.preloadCommandAssets = vi.fn(() => Promise.resolve());
    term.writeln.mockClear();

    await term.executeCommandLine("quiet | grep anything", {
      promptAfter: false,
      showLeadingNewline: false,
    });

    expect(producer).toHaveBeenCalledOnce();
    expect(term.writeln).not.toHaveBeenCalled();
    expect(term.history).toEqual(["quiet | grep anything"]);
    expect(term.busy).toBe(false);
  });

  it("does not match ANSI control bytes as visible producer text", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    term.command = vi.fn(() => term.writeln("\x1b[31mred\x1b[0m"));
    term.writeln.mockClear();

    await term.executeCommandLine("fake | grep 31m", {
      promptAfter: false,
      showLeadingNewline: false,
    });

    expect(term.command).toHaveBeenCalledOnce();
    expect(term.writeln).not.toHaveBeenCalled();
  });

  it.each([
    ["fake | head nope", "head: count must be a positive base-10 integer"],
    ["fake | tail 0", "tail: count must be a positive base-10 integer"],
  ])("rejects %s before producer preload and dispatch", async (line, message) => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    const producer = vi.fn();
    term.command = producer;
    term.preloadCommandAssets = vi.fn(() => Promise.resolve());
    const stylePrint = vi.spyOn(term, "stylePrint");
    const clearCurrentLine = vi.spyOn(term, "clearCurrentLine");

    await term.executeCommandLine(line);

    expect(term.preloadCommandAssets).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
    expect(stylePrint).toHaveBeenCalledWith(message);
    expect(term.history).toEqual([line]);
    expect(clearCurrentLine).toHaveBeenCalledOnce();
    expect(term.busy).toBe(false);
  });

  it("runs the producer once before reporting and discarding an unknown filter", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    const producer = vi.fn(() => {
      term.writeln("secret producer output");
      return 0;
    });
    term.command = producer;
    const stylePrint = vi.spyOn(term, "stylePrint");
    term.writeln.mockClear();

    await term.executeCommandLine("fake | mystery");

    expect(producer).toHaveBeenCalledOnce();
    expect(stylePrint).toHaveBeenCalledWith("Unknown pipeline filter: mystery");
    expect(term.writeln).not.toHaveBeenCalledWith("secret producer output");
    expect(term.history).toEqual(["fake | mystery"]);
    expect(term.busy).toBe(false);
  });

  it("restores capture and prompt lifecycle when the producer throws", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    const producer = vi.fn(() => {
      term.writeln("partial output");
      throw new Error("producer failed");
    });
    term.command = producer;
    const stylePrint = vi.spyOn(term, "stylePrint");
    const clearCurrentLine = vi.spyOn(term, "clearCurrentLine");

    await term.executeCommandLine("fake | head 1");

    expect(producer).toHaveBeenCalledOnce();
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(stylePrint).toHaveBeenCalledWith(
      "Command failed to load required assets. Please try again."
    );
    expect(term.writeln).not.toHaveBeenCalledWith("partial output");
    expect(clearCurrentLine).toHaveBeenCalledOnce();
    expect(term.busy).toBe(false);
  });

  it("restores capture before handling a filter failure", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    term.command = vi.fn(() => term.writeln("captured"));
    env.window.Pipeline.applyPipeline = vi.fn(() => {
      expect(term.write).toBe(originalWrite);
      expect(term.writeln).toBe(originalWriteln);
      throw new Error("filter failed");
    });
    const clearCurrentLine = vi.spyOn(term, "clearCurrentLine");

    await term.executeCommandLine("fake | head 1");

    expect(term.command).toHaveBeenCalledOnce();
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(clearCurrentLine).toHaveBeenCalledOnce();
    expect(term.busy).toBe(false);
  });

  it("does not let displaced interactive work reclaim restored writers", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();

    extend(term);
    let finishInput;
    term.collectInput = vi.fn(
      () => new Promise((resolve) => {
        finishInput = resolve;
      })
    );
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    const originalCollectInput = term.collectInput;
    term.command = vi.fn(() => {
      term.collectInput("Question");
      return 0;
    });

    await term.executeCommandLine("interactive | head 1");

    expect(term.command).toHaveBeenCalledOnce();
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(term.collectInput).toBe(originalCollectInput);

    finishInput("answer");
    await Promise.resolve();

    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(term.collectInput).toBe(originalCollectInput);
  });

  it.each([
    {
      name: "successful submission",
      inputs: ["Ada", "ada@example.com", "", "", ""],
      response: { ok: true, json: vi.fn().mockResolvedValue({}) },
      expected: "Thanks for applying! We'll review your application and get back to you",
      fetches: 1,
    },
    {
      name: "cancellation",
      inputs: [null],
      response: { ok: true, json: vi.fn().mockResolvedValue({}) },
      expected: "Application cancelled.",
      fetches: 0,
    },
    {
      name: "rejected submission",
      inputs: ["Ada", "ada@example.com", "", "", ""],
      response: {
        ok: false,
        json: vi.fn().mockResolvedValue({ error: "Server failed" }),
      },
      expected: "Error submitting application: Server failed",
      fetches: 1,
    },
  ])("retains a piped apply through $name", async ({ inputs, response, expected, fetches }) => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    const fetch = installApplyCommand(term, { inputs, response });
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    const originalCollectInput = term.collectInput;
    const dispatch = vi.spyOn(term, "command");
    const prompt = vi.spyOn(term, "prompt");
    const clearCurrentLine = vi.spyOn(term, "clearCurrentLine");
    term.write.mockClear();
    term.writeln.mockClear();

    await term.executeCommandLine("apply 1 | grep -i application | tail 1", {
      showLeadingNewline: false,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(fetches);
    expect(term.history).toEqual(["apply 1 | grep -i application | tail 1"]);
    expect(env.window.dataLayer).toEqual([
      {
        args: "1 | grep -i application | tail 1",
        command: "apply",
        event: "commandSent",
      },
    ]);
    expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining(expected));
    expect(term.writeln).not.toHaveBeenCalledWith(expect.stringContaining("Great!"));
    expect(term.write).toHaveBeenCalledWith(expect.stringContaining("INPUT UI:"));
    expect(term.writeln).not.toHaveBeenCalledWith(expect.stringContaining("INPUT UI:"));
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(clearCurrentLine).toHaveBeenCalledTimes(1);
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(term.collectInput).toBe(originalCollectInput);
    expect(term.busy).toBe(false);
    expect(term.locked).toBe(false);

    term.writeln.mockClear();
    await term.executeCommandLine("jobs", {
      addToHistory: false,
      promptAfter: false,
      showLeadingNewline: false,
      trackAnalytics: false,
    });
    expect(term.writeln).toHaveBeenCalledWith(expect.stringContaining("Open positions:"));
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
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

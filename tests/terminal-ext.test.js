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

function loadAliasTerminal() {
  const term = createTerm();
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      colorText: (text) => text,
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      firm: { blurb: "", email: "hello@example.com" },
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      help: {},
      jobs: {},
      portfolio: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      team: {},
      term,
    },
  });
  env.loadScripts(["config/commands.js", "js/terminal-ext.js"]);
  const { extend } = env.exportValues(["extend"]);
  extend(term);
  return { extend, term };
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal-ext", () => {
  it("hydrates only valid persisted aliases, including prototype-shaped names", () => {
    const { extend } = loadTerminalExt();
    env.window.localStorage.setItem(
      "rootvc.aliases",
      JSON.stringify([
        ["zebra", "echo last"],
        ["constructor", "echo constructor"],
        ["__proto__", "echo proto"],
        ["bad-name", "ignored"],
        ["missing-value"],
        ["wrong-value", 42],
      ])
    );
    const term = createTerm();

    extend(term);

    expect(term.getAliases()).toEqual([
      ["__proto__", "echo proto"],
      ["constructor", "echo constructor"],
      ["zebra", "echo last"],
    ]);
    expect(term.getAlias("constructor")).toBe("echo constructor");
    expect(term.getAlias("__proto__")).toBe("echo proto");
  });

  it.each(["not json", JSON.stringify({ alias: "echo nope" })])(
    "starts with an empty alias map for malformed stored payload %s",
    (payload) => {
      const { extend } = loadTerminalExt();
      env.window.localStorage.setItem("rootvc.aliases", payload);
      const term = createTerm();

      expect(() => extend(term)).not.toThrow();
      expect(term.getAliases()).toEqual([]);
    }
  );

  it("starts safely when reading browser storage throws", () => {
    const { extend } = loadTerminalExt();
    vi.spyOn(env.window.Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const term = createTerm();

    expect(() => extend(term)).not.toThrow();
    expect(term.getAliases()).toEqual([]);
  });

  it("persists complete snapshots before committing define, redefine, and removal", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);

    expect(term.defineAlias("constructor", "echo one")).toBe(true);
    expect(term.defineAlias("Alpha", "echo alpha")).toBe(true);
    expect(term.defineAlias("constructor", "echo two")).toBe(true);
    expect(term.removeAlias("Alpha")).toBe(true);

    expect(term.getAliases()).toEqual([["constructor", "echo two"]]);
    expect(JSON.parse(env.window.localStorage.getItem("rootvc.aliases"))).toEqual([
      ["constructor", "echo two"],
    ]);

    const reloaded = createTerm();
    extend(reloaded);
    expect(reloaded.getAliases()).toEqual([["constructor", "echo two"]]);
  });

  it("does not write or mutate for invalid and unknown state operations", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.defineAlias("kept", "echo safe");
    const setItem = vi.spyOn(env.window.Storage.prototype, "setItem");
    setItem.mockClear();

    expect(term.defineAlias("bad-name", "echo nope")).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(term.getAliases()).toEqual([["kept", "echo safe"]]);

    expect(term.removeAlias("missing")).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(term.getAliases()).toEqual([["kept", "echo safe"]]);
  });

  it("leaves memory unchanged when storage rejects a mutation", () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    extend(term);
    term.defineAlias("kept", "echo safe");
    vi.spyOn(env.window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    expect(() => term.defineAlias("newAlias", "echo new")).toThrow(
      "storage unavailable"
    );
    expect(term.getAliases()).toEqual([["kept", "echo safe"]]);

    expect(() => term.removeAlias("kept")).toThrow("storage unavailable");
    expect(term.getAliases()).toEqual([["kept", "echo safe"]]);
  });

  it("preserves state across the complete alias and unalias command sequence", () => {
    const { extend, term } = loadAliasTerminal();
    const setItem = vi.spyOn(env.window.Storage.prototype, "setItem");

    term.command("alias");
    expect(term.writeln).not.toHaveBeenCalled();

    term.command("alias zebra=echo first");
    expect(JSON.parse(env.window.localStorage.getItem("rootvc.aliases"))).toEqual([
      ["zebra", "echo first"],
    ]);

    term.command("alias zebra=echo replaced");
    expect(term.getAlias("zebra")).toBe("echo replaced");

    setItem.mockClear();
    term.command("alias bad-name=echo nope");
    expect(term.writeln).toHaveBeenLastCalledWith(
      "alias: invalid name: bad-name"
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(term.getAlias("zebra")).toBe("echo replaced");

    term.command("unalias missing");
    expect(term.writeln).toHaveBeenLastCalledWith(
      "unalias: missing: not defined"
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(term.getAlias("zebra")).toBe("echo replaced");

    const reloaded = createTerm();
    env.window.term = reloaded;
    extend(reloaded);
    expect(reloaded.getAlias("zebra")).toBe("echo replaced");

    reloaded.command("unalias zebra");
    expect(reloaded.getAliases()).toEqual([]);
    expect(JSON.parse(env.window.localStorage.getItem("rootvc.aliases"))).toEqual(
      []
    );

    const secondReload = createTerm();
    env.window.term = secondReload;
    extend(secondReload);
    expect(secondReload.getAliases()).toEqual([]);
  });

  it("reports a failed unalias storage write without changing memory", () => {
    const { term } = loadAliasTerminal();
    term.command("alias kept=echo safe");
    vi.spyOn(env.window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    term.command("unalias kept");

    expect(term.writeln).toHaveBeenLastCalledWith(
      "unalias: unable to save aliases; no changes were made"
    );
    expect(term.getAlias("kept")).toBe("echo safe");
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
    expect(term.command).toHaveBeenCalledWith({
      args: [],
      cmd: "help",
      line: "help",
      name: "help",
    });
  });

  it("uses one quote-aware parse for preload and dispatch", async () => {
    const help = vi.fn();
    const { extend } = loadTerminalExt({ commands: { help } });
    const term = createTerm();
    extend(term);
    term.preloadCommandAssets = vi.fn(() => Promise.resolve());

    await term.executeCommandLine(`help "double space" 'single space' plain`);

    const parsed = {
      args: ["double space", "single space", "plain"],
      cmd: "help",
      line: `help "double space" 'single space' plain`,
      name: "help",
    };
    expect(term.preloadCommandAssets).toHaveBeenCalledWith(parsed);
    expect(help).toHaveBeenCalledWith(parsed.args);
  });

  it("expands an exact-case user alias once and appends grouped caller arguments", async () => {
    const target = vi.fn();
    const second = vi.fn();
    const { extend } = loadTerminalExt({ commands: { target, second } });
    const term = createTerm();
    extend(term);
    term.defineAlias("Run", `target "alias group"`);
    term.defineAlias("target", "second");
    term.preloadCommandAssets = vi.fn(() => Promise.resolve());

    await term.executeCommandLine(`Run 'caller group' tail`);

    expect(term.preloadCommandAssets).toHaveBeenCalledWith({
      args: ["alias group", "caller group", "tail"],
      cmd: "target",
      line: `target "alias group"`,
      name: "target",
    });
    expect(target).toHaveBeenCalledWith([
      "alias group",
      "caller group",
      "tail",
    ]);
    expect(second).not.toHaveBeenCalled();
    expect(term.history).toEqual([`Run 'caller group' tail`]);
    expect(env.window.dataLayer).toEqual([
      { args: "caller group tail", command: "run", event: "commandSent" },
    ]);

    target.mockClear();
    await term.executeCommandLine("run untouched");
    expect(target).not.toHaveBeenCalled();
    expect(term.writeln).toHaveBeenLastCalledWith(
      "Command not found: run. Try 'help' to get started."
    );
  });

  it("preloads expanded asset commands and preserves unknown-command errors", async () => {
    const cat = vi.fn();
    const getPreloadFileForCommand = vi.fn(() => "README.md");
    const ensureFileLoaded = vi.fn(() => Promise.resolve());
    const { extend } = loadTerminalExt({
      commands: { cat },
      ensureFileLoaded,
      getPreloadFileForCommand,
    });
    const term = createTerm();
    extend(term);
    term.defineAlias("read", `cat "README.md"`);
    term.defineAlias("lost", `missing "grouped arg"`);

    await term.executeCommandLine("read");
    expect(getPreloadFileForCommand).toHaveBeenCalledWith("cat", ["README.md"]);
    expect(ensureFileLoaded).toHaveBeenCalledWith("README.md");
    expect(cat).toHaveBeenCalledWith(["README.md"]);

    await term.executeCommandLine("lost tail");
    expect(term.writeln).toHaveBeenLastCalledWith(
      "Command not found: missing. Try 'help' to get started."
    );
  });

  it("allows an alias to shadow a command until it is removed", async () => {
    const help = vi.fn();
    const target = vi.fn();
    const { extend } = loadTerminalExt({ commands: { help, target } });
    const term = createTerm();
    extend(term);
    term.defineAlias("help", "target shadowed");

    await term.executeCommandLine("help caller");
    expect(target).toHaveBeenCalledWith(["shadowed", "caller"]);
    expect(help).not.toHaveBeenCalled();

    term.removeAlias("help");
    await term.executeCommandLine("help caller");
    expect(help).toHaveBeenCalledWith(["caller"]);
  });

  it("treats an empty alias value as an empty replacement token stream", async () => {
    const help = vi.fn();
    const { extend } = loadTerminalExt({ commands: { help } });
    const term = createTerm();
    extend(term);
    term.defineAlias("empty", "");

    await term.executeCommandLine("empty help grouped");

    expect(help).toHaveBeenCalledWith(["grouped"]);
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

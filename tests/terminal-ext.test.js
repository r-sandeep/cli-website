import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

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
    init: vi.fn(),
    loadAddon: vi.fn(),
    locked: false,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    open: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };

  return Object.assign(term, overrides);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal-ext", () => {
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
      manageBusy: true,
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
      expect.objectContaining({ manageBusy: false, trackAnalytics: false })
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

  it("replays deep links before the first history entry", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    const events = [];
    const deepLinkGate = createDeferred();

    extend(term);
    env.window.dataLayer = [];
    term.history = ["help"];
    term.deepLink = "whois lee";
    term.init = vi.fn(() => {
      events.push("init");
    });
    term.prompt = vi.fn((prefix = "\r\n", suffix = " ") => {
      events.push(`prompt:${prefix}:${suffix}`);
    });
    term.scrollToBottom = vi.fn(() => {
      events.push("scroll");
    });
    term.executeCommandLine = vi.fn(() => {
      events.push("deep-link:start");
      return deepLinkGate.promise.then(() => {
        events.push("deep-link:end");
      });
    });
    term.command = vi.fn(async (line) => {
      events.push(`command:${line}`);
      return 0;
    });

    const replay = term.resizeListener();

    expect(term.busy).toBe(true);
    expect(events).toEqual(["init", "deep-link:start"]);

    deepLinkGate.resolve();
    await replay;

    expect(events).toEqual([
      "init",
      "deep-link:start",
      "deep-link:end",
      "prompt:\r\n: help\r\n",
      "command:help",
      "prompt:\r\n: ",
      "scroll",
    ]);
    expect(term.history).toEqual(["help"]);
    expect(env.window.dataLayer).toEqual([]);
    expect(term.busy).toBe(false);
  });

  it("replays async history sequentially and writes the final prompt last", async () => {
    const { extend } = loadTerminalExt();
    const term = createTerm();
    const events = [];
    const deepLinkGate = createDeferred();
    const upgradeGate = createDeferred();

    extend(term);
    term.history = ["upgrade", "help"];
    term.init = vi.fn(() => {
      events.push("init");
    });
    term.prompt = vi.fn((prefix = "\r\n", suffix = " ") => {
      events.push(`prompt:${prefix}:${suffix}`);
    });
    term.scrollToBottom = vi.fn(() => {
      events.push("scroll");
    });
    term.runDeepLink = vi.fn(() => deepLinkGate.promise);
    term.command = vi.fn((line) => {
      events.push(`command:${line}:start`);
      if (line === "upgrade") {
        return upgradeGate.promise.then(() => {
          events.push("command:upgrade:end");
          return 0;
        });
      }
      events.push(`command:${line}:end`);
      return Promise.resolve(0);
    });

    const replay = term.resizeListener();

    expect(term.busy).toBe(true);

    deepLinkGate.resolve();
    await flushMicrotasks();

    expect(events).toEqual(["init", "prompt:\r\n: upgrade\r\n", "command:upgrade:start"]);

    upgradeGate.resolve();
    await replay;

    expect(events).toEqual([
      "init",
      "prompt:\r\n: upgrade\r\n",
      "command:upgrade:start",
      "command:upgrade:end",
      "prompt:\r\n: help\r\n",
      "command:help:start",
      "command:help:end",
      "prompt:\r\n: ",
      "scroll",
    ]);
    expect(term.history).toEqual(["upgrade", "help"]);
    env.window.dataLayer = [];
    expect(env.window.dataLayer).toEqual([]);
    expect(term.busy).toBe(false);
  });

  it("renders apply history without reopening interactive input and finishes unlocked", async () => {
    const applyCommand = vi.fn(async () => {
      throw new Error("apply should not run during replay");
    });
    const { extend } = loadTerminalExt({
      commands: { apply: applyCommand, help: vi.fn() },
    });
    const term = createTerm();

    extend(term);
    term.history = ["apply job-123", "help"];
    term.init = vi.fn();
    term.runDeepLink = vi.fn(() => Promise.resolve());
    term.prompt = vi.fn();
    term.command = vi.fn((line) => {
      const fn = env.window.commands[term.parseCommandLine(line).cmd];
      return fn ? fn(term.parseCommandLine(line).args) : 0;
    });

    await term.resizeListener();

    expect(term.prompt).toHaveBeenNthCalledWith(1, "\r\n", " apply job-123\r\n");
    expect(term.prompt).toHaveBeenNthCalledWith(2, "\r\n", " help\r\n");
    expect(term.command).toHaveBeenCalledTimes(1);
    expect(term.command).toHaveBeenCalledWith("help");
    expect(applyCommand).not.toHaveBeenCalled();
    expect(term.onData).not.toHaveBeenCalled();
    expect(term.locked).toBe(false);
    expect(term.busy).toBe(false);
  });

  it("replays open history without opening a new window", async () => {
    let term;
    const { extend } = loadTerminalExt({
      commands: {
        open: vi.fn(([url]) => term.openURL(url)),
      },
    });
    term = createTerm();

    extend(term);
    env.window.open = vi.fn();
    term.history = ["open https://root.vc"];
    term.init = vi.fn();
    term.runDeepLink = vi.fn(() => Promise.resolve());
    term.prompt = vi.fn();
    term.command = vi.fn((line) => {
      const parsed = term.parseCommandLine(line);
      const fn = env.window.commands[parsed.cmd];
      return fn ? fn(parsed.args) : 0;
    });

    await term.resizeListener();

    expect(term.command).toHaveBeenCalledWith("open https://root.vc");
    expect(env.window.open).not.toHaveBeenCalled();
    expect(term._initialized).toBe(true);
  });

  it("coalesces concurrent resize replays behind one busy-owned promise", async () => {
    const { extend } = loadTerminalExt();
    const deepLinkGate = createDeferred();
    const gate = createDeferred();
    const term = createTerm();

    extend(term);
    term.history = ["help"];
    term.init = vi.fn();
    term.runDeepLink = vi.fn(() => deepLinkGate.promise);
    term.prompt = vi.fn();
    term.scrollToBottom = vi.fn();
    term.command = vi.fn(() => gate.promise);

    const firstReplay = term.resizeListener();
    const secondReplay = term.resizeListener();

    expect(secondReplay).toBe(firstReplay);
    expect(term.init).toHaveBeenCalledTimes(1);
    expect(term.command).not.toHaveBeenCalled();
    expect(term.busy).toBe(true);

    deepLinkGate.resolve();
    await flushMicrotasks();

    expect(term.command).toHaveBeenCalledTimes(1);

    gate.resolve(0);
    await firstReplay;

    expect(term.busy).toBe(false);
    expect(term._resizeReplayPromise).toBe(null);
  });
});

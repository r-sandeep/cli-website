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
    _core: { buffer: { x: 0 }

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
} },
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
      expected: "Application submitted successfully!",
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

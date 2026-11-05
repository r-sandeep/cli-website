import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function createTerm(overrides = {}) {
  const term = {
    VERSION: 4,
    buffer: { active: { cursorX: 0 } },
    cols: 80,
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

function loadRedirectionTerminal() {
  const term = createTerm();
  env = createBrowserEnv({
    html: "<!doctype html><html><body><div id='files-all'></div></body></html>",
    globals: {
      LOGO_TYPE: "ROOT",
      buildInfo: Object.freeze({ version: "test", buildDate: "2030-01-01" }),
      colorText: (text) => text,
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      firm: { blurb: "Root backs bold engineers.", email: "hello@example.com" },
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      help: {},
      jobs: {},
      portfolio: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      team: {
        alice: { name: "Alice", role: "Partner", description: "Alice partner" },
        bob: { name: "Bob", role: "Investor", description: "Bob investor" },
      },
      term,
    },
  });
  env.loadScripts([
    "js/pipeline.js",
    "config/fs.js",
    "config/commands.js",
    "js/terminal-ext.js",
  ]);
  const api = env.exportValues([
    "_DIRS",
    "_FILES",
    "commands",
    "extend",
    "getSessionFileLines",
    "getSessionFileNames",
    "writeSessionFile",
  ]);
  api.extend(term);
  return { ...api, term };
}

function snapshotFiles(api) {
  return Object.fromEntries(
    Object.keys(api._DIRS).map((directory) => [
      directory,
      api.getSessionFileNames(directory).map((name) => [
        name,
        api.getSessionFileLines(directory, name),
      ]),
    ])
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) env.cleanup();
  env = null;
});

describe("redirection through production dispatch", () => {
  it("replaces, appends, creates, strips ANSI, and stores final pipeline rows once", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["old"]);
    term.writeln.mockClear();

    await term.executeCommandLine("echo A>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["A"]);
    expect(term.writeln).not.toHaveBeenCalledWith("A");

    await term.executeCommandLine("echo B>>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("echo C>>created", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["A", "B"]);
    expect(api.getSessionFileLines("~", "created")).toEqual(["C"]);

    const originalEcho = api.commands.echo;
    const producer = vi.fn(() => {
      term.writeln("\x1b[31mpartner alpha\x1b[0m");
      term.writeln("investor beta");
      term.writeln("partner gamma");
    });
    api.commands.rows = producer;
    await term.executeCommandLine("rows | grep -i partner >team.txt", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("rows | head 3 >>team.txt", {
      promptAfter: false,
      showLeadingNewline: false,
    });

    expect(producer).toHaveBeenCalledTimes(2);
    expect(api.getSessionFileLines("~", "team.txt")).toEqual([
      "partner alpha",
      "partner gamma",
      "partner alpha",
      "investor beta",
      "partner gamma",
    ]);
    expect(api.commands.echo).toBe(originalEcho);
    expect(term.history).toEqual([
      "echo A>notes",
      "echo B>>notes",
      "echo C>>created",
      "rows | grep -i partner >team.txt",
      "rows | head 3 >>team.txt",
    ]);
    expect(env.window.dataLayer).toHaveLength(5);
  });

  it("executes the README overwrite, read, append, and read example through production dispatch", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    const readme = readFileSync("README.md", "utf8");
    const example = readme.match(
      /```\necho first > notes\.txt\ncat notes\.txt\necho second >> notes\.txt\ncat notes\.txt\n```/
    );
    expect(example).not.toBeNull();
    const lines = example[0].slice(4, -4).split("\n");

    await term.executeCommandLine(lines[0], {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes.txt")).toEqual(["first"]);

    term.writeln.mockClear();
    await term.executeCommandLine(lines[1], {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["first"]);

    term.writeln.mockClear();
    await term.executeCommandLine(lines[2], {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes.txt")).toEqual([
      "first",
      "second",
    ]);

    term.writeln.mockClear();
    await term.executeCommandLine(lines[3], {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "first",
      "second",
    ]);
  });

  it("distinguishes no output from a blank row and preserves exact special characters", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["keep"]);

    await term.executeCommandLine("cd . >empty", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("cd . >>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("cd . >>missing", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "empty")).toEqual([]);
    expect(api.getSessionFileLines("~", "notes")).toEqual(["keep"]);
    expect(api.getSessionFileLines("~", "missing")).toEqual([]);

    api.commands.special = () => {
      term.writeln("");
      term.writeln("<x> & 'single' \"double\"");
    };
    await term.executeCommandLine("special >literal", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "literal")).toEqual([
      "",
      "<x> & 'single' \"double\"",
    ]);

    term.writeln.mockClear();
    await term.executeCommandLine("cat empty", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln).not.toHaveBeenCalled();
    await term.executeCommandLine("cat literal | grep x", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln).toHaveBeenLastCalledWith("<x> & 'single' \"double\"");
  });

  it.each([
    ["echo A>", "missing file name"],
    [">notes", "missing command"],
    ["echo A>two names", "exactly one file name"],
    ["echo A>notes>again", "more than one redirection operator"],
    ["echo A>.hidden", "invalid file name"],
    ["echo A>id_rsa", "built-in file"],
  ])("rejects %s atomically", async (line, problem) => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "seed", ["one"]);
    api.writeSessionFile("/", "seed", ["other"]);
    const before = snapshotFiles(api);
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const stylePrint = vi.spyOn(term, "stylePrint");

    await term.executeCommandLine(line, {
      promptAfter: false,
      showLeadingNewline: false,
    });

    expect(preload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(snapshotFiles(api)).toEqual(before);
    expect(stylePrint).toHaveBeenCalledTimes(1);
    expect(stylePrint.mock.calls[0][0]).toMatch(/^redirect:/);
    expect(stylePrint.mock.calls[0][0]).toContain(problem);
    expect(term.history).toEqual([line]);
    expect(env.window.dataLayer).toHaveLength(1);
    expect(term.busy).toBe(false);
  });

  it("rejects visible directories but permits a guest-hidden built-in name", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    term.cwd = "/";
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const stylePrint = vi.spyOn(term, "stylePrint");

    await term.executeCommandLine("echo A>bin", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(stylePrint).toHaveBeenCalledWith(expect.stringMatching(/^redirect:.*directory/));

    term.cwd = "~";
    dispatch.mockClear();
    await term.executeCommandLine("echo hidden>README.md", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(api.getSessionFileLines("~", "README.md")).toEqual(["hidden"]);
  });

  it.each([
    ["echo A |", "Pipeline stages cannot be empty"],
    ["echo A | grep", "grep: a pattern is required"],
    ["echo A | grep -x A", "grep: supported flags are -i, -v, and -n"],
    ["echo A | head nope", "head: count must be a positive base-10 integer"],
    ["echo A | tail 0", "tail: count must be a positive base-10 integer"],
    ["echo A | wc", "wc: only wc -l is supported"],
  ])("preserves pipeline validation for %s before mutation", async (command, diagnostic) => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["unchanged"]);
    const before = snapshotFiles(api);
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const stylePrint = vi.spyOn(term, "stylePrint");

    await term.executeCommandLine(`${command} >notes`, {
      promptAfter: false,
      showLeadingNewline: false,
    });

    expect(preload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(snapshotFiles(api)).toEqual(before);
    expect(stylePrint).toHaveBeenCalledWith(diagnostic);
  });

  it("commits to the submission directory and isolates same-name files", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;

    await term.executeCommandLine("cd / >notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.cwd).toBe("/");
    expect(api.getSessionFileLines("~", "notes")).toEqual([]);
    expect(api.getSessionFileLines("/", "notes")).toBeNull();

    await term.executeCommandLine("echo root>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    term.cwd = "~";
    await term.executeCommandLine("echo home>>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("/", "notes")).toEqual(["root"]);
    expect(api.getSessionFileLines("~", "notes")).toEqual(["home"]);
  });

  it("keeps guest and root home files isolated through direct production dispatch", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    const stylePrint = vi.spyOn(term, "stylePrint");

    await term.executeCommandLine("echo guest>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("su root", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.user).toBe("root");
    expect(term.cwd).toBe("~");

    term.writeln.mockClear();
    stylePrint.mockClear();
    await term.executeCommandLine("cat notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln).not.toHaveBeenCalledWith("guest");
    expect(stylePrint).toHaveBeenCalledWith("No such file: notes");

    await term.executeCommandLine("echo root>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes", "root")).toEqual(["root"]);
    expect(api.getSessionFileLines("~", "notes", "guest")).toEqual(["guest"]);

    await term.executeCommandLine("su guest", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.user).toBe("guest");
    term.writeln.mockClear();
    await term.executeCommandLine("cat notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln).toHaveBeenCalledWith("guest");
    expect(term.writeln).not.toHaveBeenCalledWith("root");
  });

  it("keeps root and guest home files isolated in the reverse direction", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    const stylePrint = vi.spyOn(term, "stylePrint");

    await term.executeCommandLine("su root", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("echo root-only>private", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("su guest", {
      promptAfter: false,
      showLeadingNewline: false,
    });

    term.writeln.mockClear();
    stylePrint.mockClear();
    await term.executeCommandLine("cat private", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln).not.toHaveBeenCalledWith("root-only");
    expect(stylePrint).toHaveBeenCalledWith("No such file: private");
    expect(api.getSessionFileLines("~", "private", "guest")).toBeNull();
    expect(api.getSessionFileLines("~", "private", "root")).toEqual(["root-only"]);
  });

  it("does not commit partial output when producer or filter processing fails", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["safe"]);
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    api.commands.fail = () => {
      term.writeln("partial");
      throw new Error("failed");
    };

    await term.executeCommandLine("fail >notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["safe"]);
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);

    api.commands.rows = () => term.writeln("secret");
    await term.executeCommandLine("rows | mystery >notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["safe"]);
  });

  it("serializes foreground preload and width replay without discarding the live write", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["seed"]);
    api.writeSessionFile("~", "second", ["keep"]);
    api.writeSessionFile("/", "root-file", ["root"]);
    const preload = deferred();
    const originalPreload = term.preloadCommandAssets;
    let gateForeground = true;
    term.preloadCommandAssets = vi.fn((...args) => {
      if (gateForeground) {
        gateForeground = false;
        return preload.promise;
      }
      return originalPreload(...args);
    });
    term.init = vi.fn();
    term.prompt = vi.fn();

    const foreground = term.executeCommandLine("echo LIVE>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await vi.waitFor(() => expect(term.preloadCommandAssets).toHaveBeenCalledOnce());
    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 100; });
    const resize = term.resizeListener();

    expect(api.getSessionFileLines("~", "notes")).toEqual(["seed"]);
    expect(term.init).not.toHaveBeenCalled();
    preload.resolve();
    await Promise.all([foreground, resize]);

    expect(snapshotFiles(api)).toEqual({
      "~": [["notes", ["LIVE"]], ["second", ["keep"]]],
      "/": [["root-file", ["root"]]],
      home: [],
      bin: [],
    });

    term.writeln.mockClear();
    await term.executeCommandLine("cat notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["LIVE"]);
    await term.executeCommandLine("echo NEXT>>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["LIVE", "NEXT"]);
  });

  it("queues foreground capture behind replay and restores writers after failures", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["seed"]);
    const replayGate = deferred();
    let replaying = false;
    api.commands.historical = async () => {
      replaying = true;
      await replayGate.promise;
      term.writeln("replay-only");
    };
    term.history = ["historical"];
    term.init = vi.fn();
    term.prompt = vi.fn();
    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 100; });
    const resize = term.resizeListener();
    await vi.waitFor(() => expect(replaying).toBe(true));

    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    const echo = vi.spyOn(api.commands, "echo");
    const foreground = term.executeCommandLine("echo LIVE>>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await Promise.resolve();
    expect(echo).not.toHaveBeenCalled();

    replayGate.resolve();
    await Promise.all([resize, foreground]);
    expect(echo).toHaveBeenCalledTimes(1);
    expect(api.getSessionFileLines("~", "notes")).toEqual(["seed", "LIVE"]);
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);

    api.commands.fail = async () => {
      term.writeln("partial");
      throw new Error("producer failed");
    };
    await term.executeCommandLine("fail >notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["seed", "LIVE"]);
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);

    await term.executeCommandLine("echo RECOVER>recovered", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "recovered")).toEqual(["RECOVER"]);
  });

  it("keeps append and final pipeline capture exact across repeated queued resizes", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["seed"]);
    const appendGate = deferred();
    api.commands.appendrows = async () => {
      term.writeln("\x1b[31mfirst-visible-row\x1b[0m");
      await appendGate.promise;
      term.writeln("second-visible-row");
    };
    term.init = vi.fn();
    term.prompt = vi.fn();
    const originalMethods = {
      clearCurrentLine: term.clearCurrentLine,
      collectInput: term.collectInput,
      prompt: term.prompt,
      write: term.write,
      writeln: term.writeln,
    };

    const append = term.executeCommandLine("appendrows>>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await vi.waitFor(() => expect(term.writeln).not.toBe(originalMethods.writeln));
    env.window.fitAddon.fit
      .mockImplementationOnce(() => { term.cols = 100; })
      .mockImplementationOnce(() => { term.cols = 120; });
    const firstResize = term.resizeListener();
    const secondResize = term.resizeListener();
    appendGate.resolve();
    await Promise.all([append, firstResize, secondResize]);

    expect(api.getSessionFileLines("~", "notes")).toEqual([
      "seed",
      "first-visible-row",
      "second-visible-row",
    ]);
    for (const [method, identity] of Object.entries(originalMethods)) {
      expect(term[method]).toBe(identity);
    }
    expect(term.history).toEqual(["appendrows>>notes"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "appendrows>>notes", args: "" },
    ]);

    const pipelineGate = deferred();
    api.commands.pipelinerows = async () => {
      term.writeln("\x1b[32mfirst-visible-row\x1b[0m");
      await pipelineGate.promise;
      term.writeln("second-visible-row");
    };
    const pipeline = term.executeCommandLine("pipelinerows|head 1>result", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await vi.waitFor(() => expect(term.writeln).not.toBe(originalMethods.writeln));
    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 140; });
    const pipelineResize = term.resizeListener();
    pipelineGate.resolve();
    await Promise.all([pipeline, pipelineResize]);

    expect(api.getSessionFileLines("~", "result")).toEqual([
      "first-visible-row",
    ]);
    for (const [method, identity] of Object.entries(originalMethods)) {
      expect(term[method]).toBe(identity);
    }
    term.writeln.mockClear();
    await term.executeCommandLine("cat result", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    await term.executeCommandLine("echo Z|wc -l", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "first-visible-row",
      "1",
    ]);
  });

  it("releases lifecycle ownership after replay failure and permits recovery", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    api.writeSessionFile("~", "notes", ["safe"]);
    const replayFailure = new Error("replay init failed");
    term.init = vi.fn()
      .mockImplementationOnce(() => { throw replayFailure; })
      .mockImplementation(() => undefined);
    term.prompt = vi.fn();
    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 100; });

    await expect(term.resizeListener()).rejects.toBe(replayFailure);
    expect(term._initialized).toBe(true);
    expect(api.getSessionFileLines("~", "notes")).toEqual(["safe"]);

    await term.executeCommandLine("echo RECOVER>recovered", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    term.writeln.mockClear();
    await term.executeCommandLine("cat recovered", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "recovered")).toEqual(["RECOVER"]);
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["RECOVER"]);

    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 120; });
    await expect(term.resizeListener()).resolves.toBeUndefined();
    expect(term._initialized).toBe(true);
    expect(api.getSessionFileLines("~", "notes")).toEqual(["safe"]);
    expect(api.getSessionFileLines("~", "recovered")).toEqual(["RECOVER"]);
  });

  it("replays redirected history in an isolated store across repeated redraws", async () => {
    const api = loadRedirectionTerminal();
    const { term } = api;
    env.window.__term = term;
    await term.executeCommandLine("echo A>notes");
    await term.executeCommandLine("echo B>>notes");
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.init = vi.fn();
    term.prompt = vi.fn();

    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 100; });
    await term.resizeListener();
    env.window.fitAddon.fit.mockImplementationOnce(() => { term.cols = 120; });
    await term.resizeListener();

    expect(api.getSessionFileLines("~", "notes")).toEqual(["A", "B"]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    await term.executeCommandLine("echo C>>notes", {
      promptAfter: false,
      showLeadingNewline: false,
    });
    expect(api.getSessionFileLines("~", "notes")).toEqual(["A", "B", "C"]);
  });
});
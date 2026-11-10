import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function createTerm() {
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
  term.attachCustomKeyEventHandler = vi.fn((handler) => {
    term._customKeyHandler = handler;
  });
  term.onData = vi.fn((handler) => {
    term._onData = handler;
    return { dispose: vi.fn() };
  });
  return term;
}

function loadSession({ bigIntAvailable = true } = {}) {
  const term = createTerm();
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      _filesHere: () => [],
      buildInfo: Object.freeze({ version: "test", buildDate: "2030-01-01" }),
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
      shortcuts: {},
      team: {},
      term,
    },
  });
  if (!bigIntAvailable) env.window.BigInt = undefined;
  env.loadScripts([
    "js/pipeline.js",
    "config/commands.js",
    "js/terminal-ext.js",
    "js/terminal.js",
  ]);
  const { commands, extend, runRootTerminal } = env.exportValues([
    "commands",
    "extend",
    "runRootTerminal",
  ]);
  extend(term);
  term.pos = () => term.currentLine.length;
  return { commands, runRootTerminal, term };
}

function outputLines(term) {
  return term.writeln.mock.calls.map(([line]) => line);
}

function fitTo(term, cols) {
  env.window.fitAddon.fit.mockImplementation(() => {
    term.cols = cols;
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("history expansion through production dispatch", () => {
  it("executes the README worked example through production dispatch", async () => {
    const { term } = loadSession();

    await term.executeCommandLine("echo a");
    expect(outputLines(term)).toEqual(["", "a"]);

    term.writeln.mockClear();
    await term.executeCommandLine("!!");
    expect(outputLines(term)).toEqual(["", "echo a", "a"]);

    term.writeln.mockClear();
    await term.executeCommandLine("history");
    expect(outputLines(term)).toEqual([
      "",
      "1000  echo a",
      "1001  echo a",
      "1002  history",
    ]);

    term.writeln.mockClear();
    await term.executeCommandLine("!1000");
    await term.executeCommandLine("^a^b");
    expect(outputLines(term)).toEqual([
      "",
      "echo a",
      "a",
      "",
      "echo b",
      "b",
    ]);
    expect(term.history).toEqual([
      "echo a",
      "echo a",
      "history",
      "echo a",
      "echo b",
    ]);
  });

  it("announces, executes, stores and reports expanded source exactly once", async () => {
    const { term } = loadSession();

    await term.executeCommandLine("echo a");
    term.writeln.mockClear();
    await term.executeCommandLine("!!");
    await term.executeCommandLine("echo !! !!");

    expect(outputLines(term)).toEqual([
      "",
      "echo a",
      "a",
      "",
      "echo echo a echo a",
      "echo a echo a",
    ]);
    expect(term.history).toEqual([
      "echo a",
      "echo a",
      "echo echo a echo a",
    ]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "a" },
      { event: "commandSent", command: "echo", args: "a" },
      {
        event: "commandSent",
        command: "echo",
        args: "echo a echo a",
      },
    ]);
  });

  it("retains exact expanded spacing in history, announcement and production recall", async () => {
    const { runRootTerminal, term } = loadSession();
    await term.executeCommandLine("echo seed");
    term.writeln.mockClear();

    await term.executeCommandLine("  !!  ");

    expect(outputLines(term)).toEqual(["", "  echo seed  ", "seed"]);
    expect(term.history).toEqual(["echo seed", "  echo seed  "]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "seed",
    });

    term.init = vi.fn();
    term.runDeepLink = vi.fn();
    runRootTerminal(term);
    term._onData("\u001b[A");
    expect(term.currentLine).toBe("  echo seed  ");
  });

  it("retains expanded reset commands for history and production recall", async () => {
    const { runRootTerminal, term } = loadSession();
    await term.executeCommandLine("echo zsh");
    term.writeln.mockClear();

    await term.executeCommandLine("^echo ^");

    expect(outputLines(term)[0]).toBe("");
    expect(outputLines(term)[1]).toBe("zsh");
    expect(term.history).toEqual(["echo zsh", "zsh"]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "zsh",
      args: "",
    });

    term.init = vi.fn();
    term.runDeepLink = vi.fn();
    runRootTerminal(term);
    term._onData("\u001b[A");
    expect(term.currentLine).toBe("zsh");
  });

  it("preserves directly typed reset command history clearing", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("echo seed");

    await term.executeCommandLine("zsh");

    expect(term.history).toEqual([]);
  });

  it("dispatches numbered, relative, prefix and quick substitutions through real commands", async () => {
    const { term } = loadSession();

    await term.executeCommandLine("echo zero");
    await term.executeCommandLine("echo one");
    await term.executeCommandLine("!1000");
    await term.executeCommandLine("!-2");
    await term.executeCommandLine("!echo");
    await term.executeCommandLine("^one^fixed");

    expect(term.history).toEqual([
      "echo zero",
      "echo one",
      "echo zero",
      "echo one",
      "echo one",
      "echo fixed",
    ]);
    expect(outputLines(term)).toEqual(
      expect.arrayContaining(["echo zero", "echo one", "echo fixed", "fixed"])
    );
  });

  it("dispatches bounded numbers and rejects huge events when BigInt is unavailable", async () => {
    const { term } = loadSession({ bigIntAvailable: false });
    await term.executeCommandLine("echo zero");
    await term.executeCommandLine("echo one");
    term.writeln.mockClear();

    await term.executeCommandLine("!0001000");
    expect(outputLines(term)).toEqual(["", "echo zero", "zero"]);
    expect(term.history).toEqual(["echo zero", "echo one", "echo zero"]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "zero",
    });

    const huge = `!${"9".repeat(300)}`;
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.writeln.mockClear();
    await term.executeCommandLine(huge);
    expect(outputLines(term)).toEqual(["", `${huge}: event not found`]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.writeln.mockClear();
    await term.executeCommandLine("echo ok");
    expect(outputLines(term)).toEqual(["", "ok"]);
    expect(term.history).toEqual([...historyBefore, "echo ok"]);
    expect(env.window.dataLayer).toEqual([
      ...analyticsBefore,
      { event: "commandSent", command: "echo", args: "ok" },
    ]);
  });

  it.each([
    [[], "!!", "!!: event not found"],
    [["echo a"], "!999", "!999: event not found"],
    [["echo a"], "!1001", "!1001: event not found"],
    [["echo a"], "!-2", "!-2: event not found"],
    [["echo a"], "!missing", "!missing: event not found"],
    [["echo a"], "!! !missing !1001", "!missing: event not found"],
    [[], "^a^b", "substitution failed"],
    [["echo a"], "^^b", "substitution failed"],
    [["echo a"], "^missing^b", "substitution failed"],
  ])("rejects %s without any submission side effects", async (history, line, message) => {
    const { term } = loadSession();
    term.history = [...history];
    term.defineAlias("kept", "echo safe");
    term.environment.set("KEPT", "safe");
    const historyBefore = [...term.history];
    const aliasesBefore = term.getAliases();
    const variablesBefore = term.environment.entries();
    const analyticsBefore = env.window.dataLayer;
    term.writeln.mockClear();
    env.window.ensureASCIIArt.mockClear();
    env.window.ensureFileLoaded.mockClear();

    await term.executeCommandLine(line);

    expect(outputLines(term)).toEqual(["", message]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toBe(analyticsBefore);
    expect(term.getAliases()).toEqual(aliasesBefore);
    expect(term.environment.entries()).toEqual(variablesBefore);
    expect(env.window.ensureASCIIArt).not.toHaveBeenCalled();
    expect(env.window.ensureFileLoaded).not.toHaveBeenCalled();
    expect(term.busy).toBe(false);

    await term.executeCommandLine("echo ok");
    expect(outputLines(term).slice(-2)).toEqual(["", "ok"]);
    expect(term.history).toEqual([...historyBefore, "echo ok"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "ok" },
    ]);
  });

  it("recovers through the production Enter path after a rejected upgrade-prefixed source", async () => {
    const { runRootTerminal, term } = loadSession();
    term.init = vi.fn();
    term.runDeepLink = vi.fn();
    runRootTerminal(term);

    for (const character of "upgrade !missing") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() =>
      expect(outputLines(term)).toContain("!missing: event not found")
    );
    expect(term.currentLine).toBe("");
    expect(term.busy).toBe(false);

    for (const character of "echo ok") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo ok"]));
    expect(outputLines(term).filter((line) => line === "ok")).toHaveLength(1);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "ok" },
    ]);
  });

  it("records and reports a successful quick substitution to an empty line", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("x");
    const analyticsBefore = [...env.window.dataLayer];
    term.writeln.mockClear();

    await term.executeCommandLine("^x^");

    expect(outputLines(term)).toEqual(["", ""]);
    expect(term.history).toEqual(["x", ""]);
    expect(env.window.dataLayer).toEqual([
      ...analyticsBefore,
      { event: "commandSent", command: "", args: "" },
    ]);
    expect(term.currentLine).toBe("");
    expect(term.busy).toBe(false);
  });

  it("preserves literal bangs through real echo without announcements", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("echo seed");
    term.writeln.mockClear();

    for (const line of [
      "echo '!!'",
      String.raw`echo \!`,
      "echo hi!",
      "echo a ! b",
      "echo !=",
      "echo !$",
    ]) {
      await term.executeCommandLine(line);
    }

    expect(outputLines(term)).toEqual([
      "", "!!",
      "", String.raw`\!`,
      "", "hi!",
      "", "a ! b",
      "", "!=",
      "", "!$",
    ]);
  });

  it("expands only submitted source before aliases and variables and excludes announcements from pipelines", async () => {
    const { term } = loadSession();
    term.defineAlias("k", "echo !!");
    term.environment.set("V", "!!");
    await term.executeCommandLine("k");
    await term.executeCommandLine("echo $V");
    expect(outputLines(term).slice(-4)).toEqual(["", "!!", "", "!!"]);

    await term.executeCommandLine("echo a");
    await term.executeCommandLine("^a^!!");
    term.writeln.mockClear();
    await term.executeCommandLine("!!");
    expect(outputLines(term)).toEqual(["", "echo !!", "!!"]);

    await term.executeCommandLine("echo c");
    term.writeln.mockClear();
    await term.executeCommandLine("!! | wc -l");
    expect(outputLines(term)).toEqual(["", "echo c | wc -l", "1"]);
    expect(term.history.at(-1)).toBe("echo c | wc -l");
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "c | wc -l",
    });
  });

  it("uses plain announcement bytes before styled command output", async () => {
    const { term } = loadSession();
    const source = "echo https://root.vc/%echo%";
    await term.executeCommandLine(source);
    term.writeln.mockClear();

    await term.executeCommandLine("!!");

    expect(outputLines(term)[0]).toBe("");
    expect(outputLines(term)[1]).toBe(source);
  });

  it("replays expanded history without re-expansion, announcements or side effects", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("echo a");
    await term.executeCommandLine("!!");
    await term.executeCommandLine("^a^b");
    await term.executeCommandLine("alias k=echo q");
    await term.executeCommandLine("k");
    await term.executeCommandLine("echo c");
    await term.executeCommandLine("!! | wc -l");
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    const variablesBefore = term.environment.entries();
    term.runDeepLink = vi.fn(() => Promise.resolve());
    term.writeln.mockClear();
    env.window.__term = term;

    fitTo(term, 100);
    await term.resizeListener();
    fitTo(term, 120);
    await term.resizeListener();
    const callsAfterWidthReplays = outputLines(term);
    await term.resizeListener();

    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);
    expect(term.environment.entries()).toEqual(variablesBefore);
    expect(callsAfterWidthReplays.filter((line) => line === "echo a")).toHaveLength(0);
    expect(callsAfterWidthReplays.filter((line) => line === "echo b")).toHaveLength(0);
    expect(callsAfterWidthReplays.filter((line) => line === "1")).toHaveLength(2);
    expect(outputLines(term)).toEqual(callsAfterWidthReplays);

    await term.executeCommandLine("echo next");
    expect(outputLines(term).slice(-2)).toEqual(["", "next"]);
    expect(term.history).toEqual([...historyBefore, "echo next"]);
    expect(env.window.dataLayer).toEqual([
      ...analyticsBefore,
      { event: "commandSent", command: "echo", args: "next" },
    ]);
  });

  it.each(["zsh", "clear"])(
    "preserves expanded %s and complete history through repeated production width replay",
    async (resetCommand) => {
      const { runRootTerminal, term } = loadSession();
      runRootTerminal(term);

      await term.executeCommandLine(`echo ${resetCommand}`);
      await term.executeCommandLine("^echo ^");
      await term.executeCommandLine("echo tail");
      const historyBefore = [...term.history];
      const analyticsBefore = [...env.window.dataLayer];
      expect(historyBefore).toEqual([
        `echo ${resetCommand}`,
        resetCommand,
        "echo tail",
      ]);

      term.writeln.mockClear();
      term.write.mockClear();
      fitTo(term, 100);
      await term.resizeListener();
      const firstReplay = outputLines(term);
      expect(firstReplay.filter((line) => line === resetCommand)).toHaveLength(1);
      expect(firstReplay.filter((line) => line === "tail")).toHaveLength(1);
      for (const source of historyBefore) {
        expect(
          term.write.mock.calls.filter(
            ([text]) => text === `\r\n${term.promptText()} ${source}\r\n`
          )
        ).toHaveLength(1);
      }
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);

      term.writeln.mockClear();
      term.write.mockClear();
      fitTo(term, 120);
      await term.resizeListener();
      const secondReplay = outputLines(term);
      expect(secondReplay.filter((line) => line === resetCommand)).toHaveLength(1);
      expect(secondReplay.filter((line) => line === "tail")).toHaveLength(1);
      for (const source of historyBefore) {
        expect(
          term.write.mock.calls.filter(
            ([text]) => text === `\r\n${term.promptText()} ${source}\r\n`
          )
        ).toHaveLength(1);
      }
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);

      term.writeln.mockClear();
      await term.resizeListener();
      expect(outputLines(term)).toEqual([]);
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);

      term._onData("\u001b[A");
      expect(term.currentLine).toBe("echo tail");
      term._onData("\u001b[A");
      expect(term.currentLine).toBe(resetCommand);
      term._onData("\u001b[B");
      expect(term.currentLine).toBe("echo tail");
      term._onData("\u001b[B");
      expect(term.currentLine).toBe("");
    }
  );

  it("replays reset, opaque bangs and a pipeline once per width and remains usable", async () => {
    const { runRootTerminal, term } = loadSession();
    runRootTerminal(term);
    await term.executeCommandLine("echo zsh");
    await term.executeCommandLine("^echo ^");
    await term.executeCommandLine("echo a");
    await term.executeCommandLine("^a^!!");
    await term.executeCommandLine("echo c");
    await term.executeCommandLine("!! | wc -l");
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    const variablesBefore = term.environment.entries();
    expect(historyBefore).toEqual([
      "echo zsh",
      "zsh",
      "echo a",
      "echo !!",
      "echo c",
      "echo c | wc -l",
    ]);

    for (const width of [100, 120]) {
      term.writeln.mockClear();
      term.write.mockClear();
      fitTo(term, width);
      await term.resizeListener();
      const replayOutput = outputLines(term);
      expect(replayOutput.filter((line) => line === "zsh")).toHaveLength(1);
      expect(replayOutput.filter((line) => line === "!!")).toHaveLength(1);
      expect(replayOutput.filter((line) => line === "1")).toHaveLength(1);
      expect(replayOutput).not.toContain("echo !!");
      expect(replayOutput).not.toContain("echo c | wc -l");
      for (const source of historyBefore) {
        expect(
          term.write.mock.calls.filter(
            ([text]) => text === `\r\n${term.promptText()} ${source}\r\n`
          )
        ).toHaveLength(1);
      }
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);
      expect(term.environment.entries()).toEqual(variablesBefore);
    }

    term.writeln.mockClear();
    await term.executeCommandLine("echo next");
    await term.executeCommandLine("history");
    expect(outputLines(term).slice(0, 2)).toEqual(["", "next"]);
    expect(term.history).toEqual([...historyBefore, "echo next", "history"]);
    expect(env.window.dataLayer).toEqual([
      ...analyticsBefore,
      { event: "commandSent", command: "echo", args: "next" },
      { event: "commandSent", command: "history", args: "" },
    ]);
    expect(outputLines(term)).toEqual(
      expect.arrayContaining([
        "1000  echo zsh",
        "1001  zsh",
        "1002  echo a",
        "1003  echo !!",
        "1004  echo c",
        "1005  echo c | wc -l",
        "1006  echo next",
        "1007  history",
      ])
    );
  });

  it.each(["zsh", "clear"])(
    "restores directly typed %s semantics after replay protection ends",
    async (resetCommand) => {
      const { runRootTerminal, term } = loadSession();
      runRootTerminal(term);
      await term.executeCommandLine("echo seed");
      fitTo(term, 100);
      await term.resizeListener();
      expect(term.history).toEqual(["echo seed"]);

      await term.executeCommandLine(resetCommand);
      expect(term.history).toEqual([]);

      await term.executeCommandLine("echo ok");
      expect(term.history).toEqual(["echo ok"]);
      term._onData("\u001b[A");
      expect(term.currentLine).toBe("echo ok");
      term._onData("\u001b[B");
      expect(term.currentLine).toBe("");

      fitTo(term, 120);
      await term.resizeListener();
      await term.executeCommandLine(`echo ${resetCommand}`);
      await term.executeCommandLine("^echo ^");
      expect(term.history).toEqual([
        "echo ok",
        `echo ${resetCommand}`,
        resetCommand,
      ]);
    }
  );

  it.each(["clear", "zsh"])(
    "lets a real %s deep link reset history before repeated width replay",
    async (resetCommand) => {
      const { runRootTerminal, term } = loadSession();
      runRootTerminal(term);
      await term.executeCommandLine("echo a");
      await term.executeCommandLine("!!");
      const analyticsBefore = [...env.window.dataLayer];
      term.deepLink = resetCommand;

      term.writeln.mockClear();
      term.write.mockClear();
      fitTo(term, 100);
      await term.resizeListener();

      expect(term.history).toEqual([]);
      expect(env.window.dataLayer).toEqual(analyticsBefore);
      expect(term.write).not.toHaveBeenCalledWith(
        `\r\n${term.promptText()} echo a\r\n`
      );
      expect(outputLines(term)).not.toContain("a");

      await term.executeCommandLine("history");
      expect(term.history).toEqual(["history"]);
      expect(outputLines(term).slice(-2)).toEqual(["", "1000  history"]);
      term.currentLine = "";
      term.historyCursor = -1;
      term._onData("\u001b[A");
      expect(term.currentLine).toBe("history");
      term._onData("\u001b[B");
      expect(term.currentLine).toBe("");

      const outputBeforeHeightOnly = [...outputLines(term)];
      await term.resizeListener();
      expect(outputLines(term)).toEqual(outputBeforeHeightOnly);
      expect(term.history).toEqual(["history"]);

      term.writeln.mockClear();
      term.write.mockClear();
      fitTo(term, 120);
      await term.resizeListener();
      expect(term.history).toEqual([]);
      expect(outputLines(term)).not.toContain("1000  history");
      expect(env.window.dataLayer).toEqual([
        ...analyticsBefore,
        { event: "commandSent", command: "history", args: "" },
      ]);

      await term.executeCommandLine("echo ok");
      expect(term.history).toEqual(["echo ok"]);
      expect(outputLines(term).slice(-2)).toEqual(["", "ok"]);
    }
  );

  it.each([
    ["alias", "reset", "clear"],
    ["pipeline", "clear | wc -l", "clear"],
  ])(
    "applies deep-link reset policy through the real %s dispatch path",
    async (_route, deepLink, resetCommand) => {
      const { runRootTerminal, term } = loadSession();
      runRootTerminal(term);
      if (deepLink === "reset") {
        const aliasResult = term.defineAlias("reset", resetCommand);
        expect(aliasResult).toBe(true);
      }
      await term.executeCommandLine("echo seed");
      const analyticsBefore = [...env.window.dataLayer];
      term.deepLink = deepLink;
      term.writeln.mockClear();
      term.write.mockClear();

      fitTo(term, 100);
      await term.resizeListener();

      expect(term.history).toEqual([]);
      expect(env.window.dataLayer).toEqual(analyticsBefore);
      expect(term.write).not.toHaveBeenCalledWith(
        `\r\n${term.promptText()} echo seed\r\n`
      );
      expect(outputLines(term)).not.toContain("seed");
    }
  );

  it("retains non-reset deep-link replay history and output", async () => {
    const { runRootTerminal, term } = loadSession();
    runRootTerminal(term);
    await term.executeCommandLine("echo seed");
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.deepLink = "echo link";
    term.writeln.mockClear();
    term.write.mockClear();

    fitTo(term, 100);
    await term.resizeListener();

    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);
    expect(outputLines(term).filter((line) => line === "link")).toHaveLength(1);
    expect(outputLines(term).filter((line) => line === "seed")).toHaveLength(1);
    expect(term.write).toHaveBeenCalledWith(
      `\r\n${term.promptText()} echo seed\r\n`
    );
  });

  it("lets a deep-link reset clear history during another preservation scope without stale restoration", async () => {
    const { runRootTerminal, term } = loadSession();
    runRootTerminal(term);
    await term.executeCommandLine("echo upgrade");

    const upgradeGate = deferred();
    term.timer = vi.fn(() => Promise.resolve());
    term.progressBar = vi
      .fn()
      .mockImplementationOnce(() => upgradeGate.promise)
      .mockResolvedValue(undefined);
    const upgrade = term.executeCommandLine("^echo ^");
    await vi.waitFor(() => expect(term.progressBar).toHaveBeenCalledTimes(1));
    expect(term.history).toEqual(["echo upgrade", "upgrade"]);

    term.deepLink = "clear";
    fitTo(term, 100);
    await term.resizeListener();
    expect(term.history).toEqual([]);

    await term.executeCommandLine("echo next");
    expect(term.history).toEqual(["echo next"]);
    upgradeGate.resolve();
    await upgrade;

    expect(term.history).toEqual(["echo next"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "upgrade" },
      { event: "commandSent", command: "echo", args: "next" },
      { event: "commandSent", command: "upgrade", args: "" },
    ]);
  });

  it("does not activate or leak deep-link reset policy when preload fails", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("echo seed");
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.deepLink = "cat gated";
    env.window.getPreloadFileForCommand.mockReturnValue("gated");
    env.window.ensureFileLoaded.mockRejectedValue(new Error("preload failed"));
    term.writeln.mockClear();

    fitTo(term, 100);
    await term.resizeListener();

    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);
    expect(outputLines(term)).toContain(
      "Command failed to load required assets. Please try again."
    );

    env.window.getPreloadFileForCommand.mockReturnValue(null);
    env.window.ensureFileLoaded.mockResolvedValue(undefined);
    await term.executeCommandLine("clear");
    expect(term.history).toEqual([]);
    await term.executeCommandLine("echo ok");
    expect(term.history).toEqual(["echo ok"]);
  });

  it.each(["upgrade-first", "replay-first"])(
    "preserves expanded upgrade across overlapping replay when %s settles",
    async (settlementOrder) => {
      const { runRootTerminal, term } = loadSession();
      runRootTerminal(term);
      await term.executeCommandLine("echo upgrade");

      const upgradeGate = deferred();
      term.timer = vi.fn(() => Promise.resolve());
      term.progressBar = vi
        .fn()
        .mockImplementationOnce(() => upgradeGate.promise)
        .mockResolvedValue(undefined);
      const upgrade = term.executeCommandLine("^echo ^");
      await vi.waitFor(() => expect(term.progressBar).toHaveBeenCalledTimes(1));
      expect(term.history).toEqual(["echo upgrade", "upgrade"]);

      const replayGate = deferred();
      term.deepLink = "cat gated";
      env.window.getPreloadFileForCommand.mockReturnValue("gated");
      env.window.ensureFileLoaded.mockImplementation(() => replayGate.promise);
      fitTo(term, 100);
      const replay = term.resizeListener();
      await vi.waitFor(() => expect(env.window.ensureFileLoaded).toHaveBeenCalled());

      if (settlementOrder === "upgrade-first") {
        upgradeGate.resolve();
        await upgrade;
        expect(term.history).toEqual(["echo upgrade", "upgrade"]);
        replayGate.resolve();
        await replay;
      } else {
        replayGate.resolve();
        await replay;
        expect(term.history).toEqual(["echo upgrade", "upgrade"]);
        upgradeGate.resolve();
        await upgrade;
      }

      expect(term.history).toEqual(["echo upgrade", "upgrade"]);
      expect(env.window.dataLayer).toEqual([
        { event: "commandSent", command: "echo", args: "upgrade" },
        { event: "commandSent", command: "upgrade", args: "" },
      ]);
      expect(term.progressBar).toHaveBeenCalledTimes(4);

      term.currentLine = "";
      term.historyCursor = -1;
      term._onData("\u001b[A");
      expect(term.currentLine).toBe("upgrade");
      term._onData("\u001b[B");
      expect(term.currentLine).toBe("");

      term.writeln.mockClear();
      await term.executeCommandLine("echo next");
      await term.executeCommandLine("history");
      expect(term.history).toEqual([
        "echo upgrade",
        "upgrade",
        "echo next",
        "history",
      ]);
      expect(outputLines(term)).toEqual(
        expect.arrayContaining([
          "next",
          "1000  echo upgrade",
          "1001  upgrade",
          "1002  echo next",
          "1003  history",
        ])
      );
      expect(env.window.dataLayer).toEqual([
        { event: "commandSent", command: "echo", args: "upgrade" },
        { event: "commandSent", command: "upgrade", args: "" },
        { event: "commandSent", command: "echo", args: "next" },
        { event: "commandSent", command: "history", args: "" },
      ]);
    }
  );

  it("keeps overlapping replay preservation scopes independent", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("echo seed");
    const analyticsBefore = [...env.window.dataLayer];

    term.deepLink = "cat gated";
    env.window.getPreloadFileForCommand.mockReturnValue("gated");
    const firstGate = deferred();
    const secondGate = deferred();
    env.window.ensureFileLoaded
      .mockImplementationOnce(() => firstGate.promise)
      .mockImplementationOnce(() => secondGate.promise);

    fitTo(term, 100);
    const firstReplay = term.resizeListener();
    await vi.waitFor(() =>
      expect(env.window.ensureFileLoaded).toHaveBeenCalledTimes(1)
    );
    fitTo(term, 120);
    const secondReplay = term.resizeListener();
    await vi.waitFor(() =>
      expect(env.window.ensureFileLoaded).toHaveBeenCalledTimes(2)
    );

    firstGate.resolve();
    await firstReplay;
    term.init();
    expect(term.history).toEqual(["echo seed"]);

    secondGate.resolve();
    await secondReplay;
    expect(term.history).toEqual(["echo seed"]);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    await term.executeCommandLine("clear");
    expect(term.history).toEqual([]);
    await term.executeCommandLine("echo ok");
    expect(term.history).toEqual(["echo ok"]);
  });

  it("releases expanded history preservation when upgrade fails", async () => {
    const { term } = loadSession();
    await term.executeCommandLine("echo upgrade");
    term.progressBar = vi.fn(() => Promise.reject(new Error("timer failed")));
    term.writeln.mockClear();

    await term.executeCommandLine("^echo ^");
    expect(outputLines(term)).toContain(
      "Command failed to load required assets. Please try again."
    );
    expect(term.history).toEqual(["echo upgrade", "upgrade"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "upgrade" },
    ]);

    await term.executeCommandLine("clear");
    expect(term.history).toEqual([]);
    await term.executeCommandLine("echo ok");
    expect(term.history).toEqual(["echo ok"]);
    expect(outputLines(term)).toContain("ok");
  });

  it("recalls the expanded pipeline through the production keyboard handler", async () => {
    const { runRootTerminal, term } = loadSession();
    await term.executeCommandLine("echo c");
    await term.executeCommandLine("!! | wc -l");

    term.init = vi.fn();
    term.runDeepLink = vi.fn();
    runRootTerminal(term);
    term._onData("\u001b[A");
    expect(term.currentLine).toBe("echo c | wc -l");
    term._onData("\u001b[B");
    expect(term.currentLine).toBe("");

    for (const character of "echo next") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history.at(-1)).toBe("echo next"));
    expect(outputLines(term)).toContain("next");
  });
});

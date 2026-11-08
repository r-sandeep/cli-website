import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function createTerm() {
  const term = {
    VERSION: 4,
    _initialized: false,
    attachCustomKeyEventHandler: vi.fn((handler) => {
      term._customKeyHandler = handler;
    }),
    buffer: { active: { cursorX: 0 } },
    cols: 100,
    currentLine: "",
    focus: vi.fn(),
    history: [],
    loadAddon: vi.fn(),
    onData: vi.fn((handler) => {
      term._onData = handler;
      return { dispose: vi.fn() };
    }),
    open: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };
  return term;
}

function loadIntegratedTerminal({
  withKeyboard = false,
  jobs = {},
  retainProductionInitializer = false,
} = {}) {
  const term = createTerm();
  env = createBrowserEnv({
    html: "<!doctype html><html><head></head><body><div id=\"files-all\"></div></body></html>",
    globals: {
      LOGO_TYPE: "ROOT",
      buildInfo: Object.freeze({ version: "test", buildDate: "2030-04-05" }),
      colorText: (text) => `\u001b[1;35m${text}\u001b[0m`,
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      fitAddon: { fit: vi.fn() },
      firm: { blurb: "", email: "hello@example.com" },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      help: {},
      jobs,
      portfolio: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      term,
    },
  });
  env.window.fetch = vi.fn(async () => ({ text: async () => "remote built-in" }));
  env.loadScripts([
    "config/team.js",
    "js/pipeline.js",
    "config/fs.js",
    "js/bookmarks.js",
    "config/commands.js",
    "js/terminal-ext.js",
    ...(withKeyboard ? ["js/terminal.js"] : []),
  ]);
  const values = env.exportValues([
    "commands",
    "team",
    "extend",
    "resolveSessionDirectory",
    "getSessionFileLines",
    "getSessionFileNames",
    "writeSessionFile",
    "_insertFileToDOM",
    "_builtInFilesHere",
    "_filesHere",
    ...(withKeyboard ? ["runRootTerminal"] : []),
  ]);
  values.extend(term);
  if (withKeyboard) {
    if (!retainProductionInitializer) term.init = vi.fn();
    term.prompt = vi.fn();
    term.runDeepLink = vi.fn();
    term.resizeListener = vi.fn();
    term.pos = () => term.currentLine.length;
    values.runRootTerminal(term);
  }
  term.writeln.mockClear();
  term.write.mockClear();
  return { term, ...values };
}

function writtenLines(term) {
  return term.writeln.mock.calls.map(([line]) => line);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("session files through production commands", () => {
  const quiet = {
    promptAfter: false,
    showLeadingNewline: false,
    scrollAfter: false,
  };

  it("replaces, appends, filters, strips ANSI, and preserves zero-output distinctions through real dispatch", async () => {
    const { getSessionFileLines, getSessionFileNames, term } = loadIntegratedTerminal();

    await term.executeCommandLine("echo a>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["a"]);
    expect(writtenLines(term)).toEqual([]);

    await term.executeCommandLine("echo b>>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["a", "b"]);
    expect(writtenLines(term)).toEqual([]);

    await term.executeCommandLine("cat n|tail 1>p", quiet);
    expect(getSessionFileLines("/home/guest", "p")).toEqual(["b"]);
    expect(writtenLines(term)).toEqual([]);

    await term.executeCommandLine("echo replacement>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["replacement"]);
    await term.executeCommandLine("echo fresh>>missing", quiet);
    expect(getSessionFileLines("/home/guest", "missing")).toEqual(["fresh"]);

    await term.executeCommandLine("cd .>empty", quiet);
    expect(getSessionFileLines("/home/guest", "empty")).toEqual([]);
    expect(getSessionFileNames("/home/guest")).toContain("empty");
    await term.executeCommandLine("cd .>>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["replacement"]);

    term.stylePrint = (line) => term.writeln(`\u001b[31m${line}\u001b[0m`);
    await term.executeCommandLine("echo styled>ansi", quiet);
    expect(getSessionFileLines("/home/guest", "ansi")).toEqual(["styled"]);

    expect(term.history).toEqual([
      "echo a>n",
      "echo b>>n",
      "cat n|tail 1>p",
      "echo replacement>n",
      "echo fresh>>missing",
      "cd .>empty",
      "cd .>>n",
      "echo styled>ansi",
    ]);
    expect(env.window.dataLayer).toHaveLength(8);
  });

  it("executes the exact separately printed redirect examples through real dispatch", async () => {
    const { commands, getSessionFileLines, term } = loadIntegratedTerminal();

    commands.man(["redirect"]);
    const manualRows = writtenLines(term);
    const headingIndex = manualRows.indexOf("Examples (submit each line separately):");
    expect(headingIndex).toBeGreaterThan(-1);
    const examples = manualRows.slice(headingIndex + 1, headingIndex + 4);
    expect(examples).toEqual([
      "echo hello > notes.txt",
      "echo again >> notes.txt",
      "cat notes.txt",
    ]);

    term.writeln.mockClear();
    await term.executeCommandLine(examples[0], quiet);
    expect(writtenLines(term)).toEqual([]);
    expect(getSessionFileLines("/home/guest", "notes.txt")).toEqual(["hello"]);

    await term.executeCommandLine(examples[1], quiet);
    expect(writtenLines(term)).toEqual([]);
    expect(getSessionFileLines("/home/guest", "notes.txt")).toEqual([
      "hello",
      "again",
    ]);

    await term.executeCommandLine(examples[2], quiet);
    expect(writtenLines(term)).toEqual(["hello", "again"]);
    expect(getSessionFileLines("/home/guest", "notes.txt")).toEqual([
      "hello",
      "again",
    ]);
    expect(term.history).toEqual(examples);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "hello > notes.txt" },
      { event: "commandSent", command: "echo", args: "again >> notes.txt" },
      { event: "commandSent", command: "cat", args: "notes.txt" },
    ]);
  });

  it("stores only the final whois pipeline result before appending the first three rows", async () => {
    const { commands, getSessionFileLines, team, term } = loadIntegratedTerminal();
    expect(team.kane.name).toBe("Kane Hsieh");

    await term.executeCommandLine("whois | grep -i partner > team.txt", quiet);
    const matching = getSessionFileLines("/home/guest", "team.txt");
    expect(matching).toEqual([
      "whois: Learn about the firm, or a partner - usage:",
    ]);

    term.writeln.mockClear();
    await term.executeCommandLine("whois | head 3 >> team.txt", quiet);
    expect(getSessionFileLines("/home/guest", "team.txt")).toEqual([
      "whois: Learn about the firm, or a partner - usage:",
      "whois: Learn about the firm, or a partner - usage:",
      "",
      "whois root",
    ]);
    expect(writtenLines(term)).toEqual([]);

    commands.cat(["team.txt"]);
    expect(writtenLines(term)).toEqual([
      "whois: Learn about the firm, or a partner - usage:",
      "whois: Learn about the firm, or a partner - usage:",
      "",
      "whois root",
    ]);
  });

  it.each([
    ["missing filename", "export MARK=changed>", "file name required"],
    ["two filenames", "export MARK=changed>one two", "one file name required"],
    ["second operator", "export MARK=changed>one>two", "unexpected second >"],
    ["invalid filename", "export MARK=changed>.one", "invalid file name"],
    ["quoted filename", "export MARK=changed>'one'", "quoted file names"],
    ["single-quoted multiword filename", "export MARK=changed>>'one two'", "quoted file names"],
    ["double-quoted multiword filename", 'export MARK=changed>"one two"', "quoted file names"],
    ["missing command", ">one", "command required"],
    ["built-in file", "export MARK=changed>welcome.htm", "built-in file"],
  ])("rejects %s atomically before preload or dispatch", async (_label, line, problem) => {
    const { getSessionFileLines, getSessionFileNames, term, writeSessionFile } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "sentinel", ["before", "still before"]);
    const beforeNames = getSessionFileNames("/home/guest");
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");

    await term.executeCommandLine(line, quiet);

    expect(preload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.environment.get("MARK")).toBeUndefined();
    expect(getSessionFileNames("/home/guest")).toEqual(beforeNames);
    expect(getSessionFileLines("/home/guest", "sentinel")).toEqual(["before", "still before"]);
    expect(writtenLines(term)).toEqual([expect.stringMatching(/^redirect:/)]);
    expect(writtenLines(term)[0]).toContain(problem);
    expect(term.history).toEqual([line]);
    expect(env.window.dataLayer).toHaveLength(1);
  });

  it("classifies quoted targets atomically and preserves valid neighboring behavior", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["kept", "", "still kept"]);
    writeSessionFile("/home/guest", "p", ["second file"]);
    writeSessionFile("/home/root", "n", ["root file"]);
    const before = {
      guestNames: getSessionFileNames("/home/guest"),
      guestN: getSessionFileLines("/home/guest", "n"),
      guestP: getSessionFileLines("/home/guest", "p"),
      rootNames: getSessionFileNames("/home/root"),
      rootN: getSessionFileLines("/home/root", "n"),
    };
    term.environment.set("MARK", "original");
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const rejected = [
      "export MARK=changed > 'one'",
      "export MARK=changed >> 'one two'",
      'export MARK=changed > "one"',
      'export MARK=changed >> "one two"',
    ];

    const expectedAnalyticsArgs = [
      "MARK=changed > one",
      "MARK=changed >> one two",
      "MARK=changed > one",
      "MARK=changed >> one two",
    ];

    for (const [index, line] of rejected.entries()) {
      term.writeln.mockClear();
      preload.mockClear();
      dispatch.mockClear();

      await term.executeCommandLine(line, quiet);

      expect(writtenLines(term), line).toEqual([
        "redirect: quoted file names are not supported",
      ]);
      expect(preload, line).not.toHaveBeenCalled();
      expect(dispatch, line).not.toHaveBeenCalled();
      expect(term.environment.get("MARK"), line).toBe("original");
      expect(getSessionFileNames("/home/guest"), line).toEqual(before.guestNames);
      expect(getSessionFileLines("/home/guest", "n"), line).toEqual(before.guestN);
      expect(getSessionFileLines("/home/guest", "p"), line).toEqual(before.guestP);
      expect(getSessionFileNames("/home/root"), line).toEqual(before.rootNames);
      expect(getSessionFileLines("/home/root", "n"), line).toEqual(before.rootN);
      expect(term.history, line).toEqual(rejected.slice(0, index + 1));
      expect(env.window.dataLayer[index], line).toEqual({
        event: "commandSent",
        command: "export",
        args: expectedAnalyticsArgs[index],
      });
    }

    term.writeln.mockClear();
    await term.executeCommandLine("echo wrong > one two", quiet);
    expect(writtenLines(term)).toEqual(["redirect: one file name required"]);
    expect(getSessionFileNames("/home/guest")).toEqual(before.guestNames);

    term.writeln.mockClear();
    await term.executeCommandLine("echo valid>valid", quiet);
    await term.executeCommandLine('echo "a > b"', quiet);
    await term.executeCommandLine("echo after", quiet);
    await term.executeCommandLine("cat n", quiet);
    expect(getSessionFileLines("/home/guest", "valid")).toEqual(["valid"]);
    expect(writtenLines(term)).toEqual([
      "a > b",
      "after",
      "kept",
      "",
      "still kept",
    ]);
  });

  it("restores dispatcher prompt ownership for every rejected upgrade preflight", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["kept", "", "still kept"]);
    writeSessionFile("/home/root", "n", ["root"]);
    writeSessionFile("/bin", "n", ["bin"]);
    const before = {
      guestNames: getSessionFileNames("/home/guest"),
      guestN: getSessionFileLines("/home/guest", "n"),
      rootNames: getSessionFileNames("/home/root"),
      rootN: getSessionFileLines("/home/root", "n"),
      binNames: getSessionFileNames("/bin"),
      binN: getSessionFileLines("/bin", "n"),
    };
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const prompt = vi.spyOn(term, "prompt");
    const clearCurrentLine = vi.spyOn(term, "clearCurrentLine");
    const rejected = [
      ["upgrade >", "redirect: file name required"],
      ["upgrade >>", "redirect: file name required"],
      ["upgrade > welcome.htm", "redirect: target is a built-in file"],
      ["upgrade | mystery > side", "Unknown pipeline filter: mystery"],
      ["upgrade | head 0 > side", "head: count must be a positive base-10 integer"],
    ];

    for (const [index, [line, diagnostic]] of rejected.entries()) {
      term.currentLine = line;
      term.writeln.mockClear();
      preload.mockClear();
      dispatch.mockClear();
      prompt.mockClear();
      clearCurrentLine.mockClear();

      await term.executeCommandLine(line, { scrollAfter: false });

      expect(writtenLines(term), line).toEqual(["", diagnostic]);
      expect(preload, line).not.toHaveBeenCalled();
      expect(dispatch, line).not.toHaveBeenCalled();
      expect(prompt, line).toHaveBeenCalledTimes(2);
      expect(clearCurrentLine, line).toHaveBeenCalledOnce();
      expect(clearCurrentLine, line).toHaveBeenCalledWith(true);
      expect(term.currentLine, line).toBe("");
      expect(term.busy, line).toBe(false);
      expect(getSessionFileNames("/home/guest"), line).toEqual(before.guestNames);
      expect(getSessionFileLines("/home/guest", "n"), line).toEqual(before.guestN);
      expect(getSessionFileLines("/home/guest", "side"), line).toBeNull();
      expect(getSessionFileNames("/home/root"), line).toEqual(before.rootNames);
      expect(getSessionFileLines("/home/root", "n"), line).toEqual(before.rootN);
      expect(getSessionFileNames("/bin"), line).toEqual(before.binNames);
      expect(getSessionFileLines("/bin", "n"), line).toEqual(before.binN);
      expect(term.history, line).toEqual(rejected.slice(0, index + 1).map(([raw]) => raw));
      expect(env.window.dataLayer[index], line).toEqual({
        event: "commandSent",
        command: "upgrade",
        args: line.slice("upgrade ".length),
      });
    }

    term.writeln.mockClear();
    await term.executeCommandLine("echo after", quiet);
    await term.executeCommandLine("echo ok|wc -l", quiet);
    await term.executeCommandLine("cat n", quiet);
    expect(writtenLines(term)).toEqual(["after", "1", "kept", "", "still kept"]);
  });

  it("keeps the production upgrade handler's successful prompt lifecycle", async () => {
    const { term } = loadIntegratedTerminal();
    term.init = vi.fn();
    term.progressBar = vi.fn(() => Promise.resolve());
    term.delayStylePrint = vi.fn(() => Promise.resolve());
    term.dottedPrint = vi.fn(() => Promise.resolve());
    term.delayPrint = vi.fn(() => Promise.resolve());
    term.prompt = vi.fn();
    term.clearCurrentLine = vi.fn();

    await term.executeCommandLine("upgrade", { scrollAfter: false });

    expect(term.VERSION).toBe(4);
    expect(term.init).toHaveBeenCalledOnce();
    expect(term.prompt).toHaveBeenCalledOnce();
    expect(term.clearCurrentLine).toHaveBeenCalledOnce();
    expect(term.clearCurrentLine).toHaveBeenCalledWith();
    expect(term.locked).toBe(false);
    expect(term.history).toEqual(["upgrade"]);
    expect(env.window.dataLayer).toEqual([{
      event: "commandSent",
      command: "upgrade",
      args: "",
    }]);
  });

  it("rejects semantic-empty command tokens atomically and preserves submission accounting", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "first", ["alpha", "", "omega"]);
    writeSessionFile("/home/guest", "second", ["left", "right"]);
    const beforeNames = getSessionFileNames("/home/guest");
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const invalidLines = [
      '"" > emptycmd',
      "'' >> emptycmd",
      '""\'\' > emptycmd',
      '"" later > emptycmd',
      "''\"\" later >> emptycmd",
    ];

    const expectedArgs = [
      "> emptycmd",
      ">> emptycmd",
      "> emptycmd",
      "later > emptycmd",
      "later >> emptycmd",
    ];

    for (const [index, line] of invalidLines.entries()) {
      term.writeln.mockClear();
      await term.executeCommandLine(line, quiet);

      expect(preload, line).not.toHaveBeenCalled();
      expect(dispatch, line).not.toHaveBeenCalled();
      expect(writtenLines(term), line).toEqual(["redirect: command required"]);
      expect(getSessionFileNames("/home/guest"), line).toEqual(beforeNames);
      expect(getSessionFileLines("/home/guest", "first"), line).toEqual(["alpha", "", "omega"]);
      expect(getSessionFileLines("/home/guest", "second"), line).toEqual(["left", "right"]);
      expect(getSessionFileLines("/home/guest", "emptycmd"), line).toBeNull();
      expect(term.history, line).toEqual(invalidLines.slice(0, index + 1));
      expect(env.window.dataLayer, line).toHaveLength(index + 1);
      expect(env.window.dataLayer[index], line).toEqual({
        event: "commandSent",
        command: "",
        args: expectedArgs[index],
      });
      expect(term.busy, line).toBe(false);
    }

    term.writeln.mockClear();
    await term.executeCommandLine('"echo" ok > valid', quiet);
    expect(getSessionFileLines("/home/guest", "valid")).toEqual(["ok"]);
    expect(writtenLines(term)).toEqual([]);

    term.writeln.mockClear();
    await term.executeCommandLine("echo after", quiet);
    await term.executeCommandLine("echo ok|wc -l", quiet);
    expect(writtenLines(term)).toEqual(["after", "1"]);
    expect(term.busy).toBe(false);
  });

  it("rejects commands removed by alias expansion before standalone or pipeline redirection", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["guest", "", "unchanged"]);
    writeSessionFile("/home/guest", "p", ["second"]);
    writeSessionFile("/home/root", "n", ["root"]);
    writeSessionFile("/bin", "n", ["bin"]);

    await term.executeCommandLine("alias blank=", quiet);
    await term.executeCommandLine('alias emptyDouble=""', quiet);
    await term.executeCommandLine("alias emptySingle=''", quiet);
    await term.executeCommandLine(`alias emptyBoth=""''`, quiet);
    const historyPrefix = [...term.history];
    const analyticsPrefix = [...env.window.dataLayer];
    const before = {
      guestNames: getSessionFileNames("/home/guest"),
      guestN: getSessionFileLines("/home/guest", "n"),
      guestP: getSessionFileLines("/home/guest", "p"),
      rootNames: getSessionFileNames("/home/root"),
      rootN: getSessionFileLines("/home/root", "n"),
      binNames: getSessionFileNames("/bin"),
      binN: getSessionFileLines("/bin", "n"),
    };
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");
    const invalidLines = [
      "blank > fresh",
      "blank >> n",
      "emptyDouble > fresh",
      "emptySingle >> p",
      "emptyBoth | head 1 > piped",
      "blank | head 1 >> n",
    ];

    for (const [index, line] of invalidLines.entries()) {
      term.writeln.mockClear();
      preload.mockClear();
      dispatch.mockClear();
      await term.executeCommandLine(line, quiet);

      expect(writtenLines(term), line).toEqual(["redirect: command required"]);
      expect(preload, line).not.toHaveBeenCalled();
      expect(dispatch, line).not.toHaveBeenCalled();
      expect(getSessionFileNames("/home/guest"), line).toEqual(before.guestNames);
      expect(getSessionFileLines("/home/guest", "n"), line).toEqual(before.guestN);
      expect(getSessionFileLines("/home/guest", "p"), line).toEqual(before.guestP);
      expect(getSessionFileLines("/home/guest", "fresh"), line).toBeNull();
      expect(getSessionFileLines("/home/guest", "piped"), line).toBeNull();
      expect(getSessionFileNames("/home/root"), line).toEqual(before.rootNames);
      expect(getSessionFileLines("/home/root", "n"), line).toEqual(before.rootN);
      expect(getSessionFileNames("/bin"), line).toEqual(before.binNames);
      expect(getSessionFileLines("/bin", "n"), line).toEqual(before.binN);
      expect(term.history, line).toEqual([...historyPrefix, ...invalidLines.slice(0, index + 1)]);
      expect(env.window.dataLayer, line).toHaveLength(analyticsPrefix.length + index + 1);
      expect(env.window.dataLayer[analyticsPrefix.length + index], line).toEqual({
        event: "commandSent",
        command: line.split(" ")[0].toLowerCase(),
        args: line.slice(line.indexOf(" ") + 1),
      });
      expect(term.busy, line).toBe(false);
    }
  });

  it("preserves valid alias expansion and ordinary empty-alias behavior", async () => {
    const { getSessionFileLines, term } = loadIntegratedTerminal();
    await term.executeCommandLine("alias blank=", quiet);
    await term.executeCommandLine("alias sayok=echo", quiet);

    term.writeln.mockClear();
    await term.executeCommandLine("blank echo ok > supplied", quiet);
    expect(writtenLines(term)).toEqual([]);
    expect(getSessionFileLines("/home/guest", "supplied")).toEqual(["ok"]);

    await term.executeCommandLine("sayok kept > normal", quiet);
    expect(writtenLines(term)).toEqual([]);
    expect(getSessionFileLines("/home/guest", "normal")).toEqual(["kept"]);

    term.writeln.mockClear();
    await term.executeCommandLine("echo ok", quiet);
    await term.executeCommandLine("echo ok|wc -l", quiet);
    await term.executeCommandLine("cat supplied", quiet);
    expect(writtenLines(term)).toEqual(["ok", "1", "ok"]);

    term.writeln.mockClear();
    await term.executeCommandLine("blank", quiet);
    expect(writtenLines(term)).toEqual(["Command not found: . Try 'help' to get started."]);
    expect(term.busy).toBe(false);
  });

  it("rejects a missing actual pipeline producer as an atomic redirect error", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["a"]);
    writeSessionFile("/home/guest", "p", ["b"]);
    const beforeNames = getSessionFileNames("/home/guest");
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const producer = vi.spyOn(term, "command");
    const invalidLines = [
      "| head 1 > should-not-exist.txt",
      "   | head 1 >> n",
      `"" | head 1 > empty-double`,
      "'' | head 1 >> p",
    ];

    for (const [index, line] of invalidLines.entries()) {
      term.writeln.mockClear();
      await term.executeCommandLine(line, quiet);

      expect(writtenLines(term), line).toEqual(["redirect: command required"]);
      expect(preload, line).not.toHaveBeenCalled();
      expect(producer, line).not.toHaveBeenCalled();
      expect(getSessionFileNames("/home/guest"), line).toEqual(beforeNames);
      expect(getSessionFileLines("/home/guest", "n"), line).toEqual(["a"]);
      expect(getSessionFileLines("/home/guest", "p"), line).toEqual(["b"]);
      expect(getSessionFileLines("/home/guest", "should-not-exist.txt"), line).toBeNull();
      expect(getSessionFileLines("/home/guest", "empty-double"), line).toBeNull();
      expect(term.history, line).toEqual(
        invalidLines.slice(0, index + 1).map((submitted) => submitted.trim())
      );
      expect(env.window.dataLayer, line).toHaveLength(index + 1);
      expect(env.window.dataLayer[index], line).toEqual({
        event: "commandSent",
        command: index < 2 ? "|" : "",
        args: index === 0
          ? "head 1 > should-not-exist.txt"
          : index === 1
            ? "head 1 >> n"
            : index === 2
              ? "| head 1 > empty-double"
              : "| head 1 >> p",
      });
      expect(term.busy, line).toBe(false);
    }

    term.writeln.mockClear();
    await term.executeCommandLine("echo producer | head 0 > valid", quiet);
    expect(writtenLines(term)).toEqual([
      "head: count must be a positive base-10 integer",
    ]);
    expect(getSessionFileNames("/home/guest")).toEqual(beforeNames);

    term.writeln.mockClear();
    await term.executeCommandLine("| head 1", quiet);
    expect(writtenLines(term)).toEqual(["A pipeline producer is required"]);

    term.writeln.mockClear();
    await term.executeCommandLine("echo after", quiet);
    expect(writtenLines(term)).toEqual(["after"]);
    expect(term.busy).toBe(false);
  });

  it("rejects directory collisions in root before dispatch", async () => {
    const { getSessionFileNames, term } = loadIntegratedTerminal();
    term.cwd = "/";
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const dispatch = vi.spyOn(term, "dispatchCommand");

    await term.executeCommandLine("echo no>bin", quiet);

    expect(preload).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(getSessionFileNames("/")).toEqual([]);
    expect(writtenLines(term)).toEqual(["redirect: target is a directory"]);
  });

  it("gives every pre-dispatch pipeline diagnostic precedence over a built-in collision", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "sentinel", ["before", "", "after"]);
    const beforeNames = getSessionFileNames("/home/guest");
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const producer = vi.spyOn(term, "command");
    const cases = [
      ["head 0", "head: count must be a positive base-10 integer"],
      ["tail 0", "tail: count must be a positive base-10 integer"],
      ["sort -x", "sort: supported flags are -r, -n, -u"],
      ["uniq -x", "uniq: supported flags are -c, -d"],
      ["grep", "grep: a pattern is required"],
      ["", "Pipeline stages cannot be empty"],
    ];

    for (const [stage, message] of cases) {
      const line = `echo producer | ${stage}>welcome.htm`;
      term.writeln.mockClear();
      await term.executeCommandLine(line, quiet);

      expect(writtenLines(term), line).toEqual([message]);
      expect(preload, line).not.toHaveBeenCalled();
      expect(producer, line).not.toHaveBeenCalled();
      expect(getSessionFileNames("/home/guest"), line).toEqual(beforeNames);
      expect(getSessionFileLines("/home/guest", "sentinel"), line).toEqual(["before", "", "after"]);
      expect(term.busy, line).toBe(false);
      expect(env.window.dataLayer.at(-1), line).toEqual({
        event: "commandSent",
        command: "echo",
        args: `producer | ${stage}>welcome.htm`,
      });
    }

    expect(term.history).toEqual(cases.map(([stage]) =>
      `echo producer | ${stage}>welcome.htm`
    ));
    expect(env.window.dataLayer).toEqual(cases.map(([stage]) => ({
      event: "commandSent",
      command: "echo",
      args: `producer | ${stage}>welcome.htm`,
    })));

    term.writeln.mockClear();
    await term.executeCommandLine("echo producer | head 1>welcome.htm", quiet);
    expect(writtenLines(term)).toEqual(["redirect: target is a built-in file"]);
    expect(preload).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
    expect(getSessionFileNames("/home/guest")).toEqual(beforeNames);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "producer | head 1>welcome.htm",
    });
    expect(env.window.dataLayer).toHaveLength(cases.length + 1);
  });

  it("gives pipeline validation precedence over a directory collision", async () => {
    const { getSessionFileNames, term } = loadIntegratedTerminal();
    term.cwd = "/";
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const producer = vi.spyOn(term, "command");

    await term.executeCommandLine("echo producer | head 0 > bin", quiet);

    expect(writtenLines(term)).toEqual([
      "head: count must be a positive base-10 integer",
    ]);
    expect(preload).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
    expect(getSessionFileNames("/")).toEqual([]);
    expect(term.history).toEqual(["echo producer | head 0 > bin"]);
    expect(env.window.dataLayer).toHaveLength(1);
    expect(env.window.dataLayer[0]).toEqual({
      event: "commandSent",
      command: "echo",
      args: "producer | head 0 > bin",
    });
    expect(term.busy).toBe(false);

    term.writeln.mockClear();
    await term.executeCommandLine("echo producer | head 1 > bin", quiet);
    expect(writtenLines(term)).toEqual(["redirect: target is a directory"]);
    expect(preload).not.toHaveBeenCalled();
    expect(producer).not.toHaveBeenCalled();
    expect(getSessionFileNames("/")).toEqual([]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "producer | head 1 > bin",
    });
    expect(env.window.dataLayer).toHaveLength(2);
  });

  it.each([
    ["head 0", "head: count must be a positive base-10 integer"],
    ["tail 0", "tail: count must be a positive base-10 integer"],
    ["sort -x", "sort: supported flags are -r, -n, -u"],
    ["uniq -x", "uniq: supported flags are -c, -d"],
    ["grep", "grep: a pattern is required"],
    ["", "Pipeline stages cannot be empty"],
  ])("keeps redirected pipeline validation failure %s atomic", async (stage, message) => {
    const { getSessionFileLines, term, writeSessionFile } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["unchanged"]);
    const dispatch = vi.spyOn(term, "command");

    await term.executeCommandLine(`echo producer | ${stage}>n`, quiet);

    expect(dispatch).not.toHaveBeenCalled();
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["unchanged"]);
    expect(writtenLines(term)).toEqual([message]);
  });

  it("rejects redirected unknown filters before real producers and preserves ordinary deferred timing", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    term.environment.set("HUNT", "original");
    writeSessionFile("/home/guest", "n", ["a"]);
    writeSessionFile("/home/guest", "p", ["b"]);
    writeSessionFile("/home/root", "root-file", ["root"]);
    writeSessionFile("/bin", "bin-file", ["bin"]);

    const completeState = () => ({
      environment: term.environment.snapshot(),
      guestNames: getSessionFileNames("/home/guest"),
      guestN: getSessionFileLines("/home/guest", "n"),
      guestP: getSessionFileLines("/home/guest", "p"),
      guestSide: getSessionFileLines("/home/guest", "side.txt"),
      rootNames: getSessionFileNames("/home/root"),
      rootFile: getSessionFileLines("/home/root", "root-file"),
      binNames: getSessionFileNames("/bin"),
      binFile: getSessionFileLines("/bin", "bin-file"),
    });
    const before = completeState();
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const producer = vi.spyOn(term, "command");
    const lines = [
      "export HUNT=changed | mystery > side.txt",
      "export HUNT=changed | mystery | head 1 >> n",
      "export HUNT=changed | head 1 | mystery > side.txt",
      "export HUNT=changed | head 1 | mystery | tail 1 >> n",
    ];

    for (const [index, line] of lines.entries()) {
      term.writeln.mockClear();
      await term.executeCommandLine(line, quiet);

      expect(preload, line).not.toHaveBeenCalled();
      expect(producer, line).not.toHaveBeenCalled();
      expect(writtenLines(term), line).toEqual([
        "Unknown pipeline filter: mystery",
      ]);
      expect(completeState(), line).toEqual(before);
      expect(term.history, line).toEqual(lines.slice(0, index + 1));
      expect(env.window.dataLayer, line).toHaveLength(index + 1);
      expect(env.window.dataLayer[index], line).toEqual({
        event: "commandSent",
        command: "export",
        args: line.slice("export ".length),
      });
      expect(term.busy, line).toBe(false);
    }

    term.writeln.mockClear();
    await term.executeCommandLine("echo ok", quiet);
    await term.executeCommandLine("echo ok|wc -l", quiet);
    expect(writtenLines(term)).toEqual(["ok", "1"]);
    expect(term.busy).toBe(false);

    term.writeln.mockClear();
    await term.executeCommandLine("export HUNT=ordinary|mystery", quiet);
    expect(term.environment.get("HUNT")).toBe("ordinary");
    expect(writtenLines(term)).toEqual(["Unknown pipeline filter: mystery"]);
    expect(term.history.at(-1)).toBe("export HUNT=ordinary|mystery");
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "export",
      args: "HUNT=ordinary|mystery",
    });
    expect(term.busy).toBe(false);
  });

  it("does not commit unknown-filter diagnostics and restores writers after producer failure", async () => {
    const { getSessionFileLines, term, writeSessionFile } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["unchanged"]);
    const originalWrite = term.write;
    const originalWriteln = term.writeln;

    await term.executeCommandLine("echo producer | mystery>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["unchanged"]);
    expect(writtenLines(term)).toEqual(["Unknown pipeline filter: mystery"]);

    term.writeln.mockClear();
    term.preloadCommandAssets = vi.fn(() => Promise.resolve());
    term.dispatchCommand = vi.fn(() => {
      term.writeln("partial");
      throw new Error("producer failed");
    });
    await term.executeCommandLine("explode>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["unchanged"]);
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);
    expect(writtenLines(term)).toEqual([
      "Command failed to load required assets. Please try again.",
    ]);
    expect(term.busy).toBe(false);
  });

  it("holds redirected interactive output until the application workflow settles", async () => {
    let releaseName;
    const namePending = new Promise((resolve) => {
      releaseName = resolve;
    });
    const { getSessionFileLines, term } = loadIntegratedTerminal({
      jobs: { 1: ["Platform Engineer"] },
    });
    const inputValues = [namePending, "ada@example.com", "", "", ""];
    const collectInput = vi.fn(async (question) => {
      term.writeln(`INPUT UI: ${question}`);
      return await inputValues.shift();
    });
    term.collectInput = collectInput;
    env.window.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
    });

    const execution = term.executeCommandLine("apply 1>application.txt", quiet);
    await vi.waitFor(() => expect(collectInput).toHaveBeenCalledTimes(1));
    expect(getSessionFileLines("/home/guest", "application.txt")).toBeNull();
    expect(writtenLines(term)).toEqual(["INPUT UI: What's your name?"]);

    releaseName("Ada");
    await execution;

    expect(collectInput).toHaveBeenCalledTimes(5);
    expect(getSessionFileLines("/home/guest", "application.txt")).toEqual([
      "Great! Let's get your application started. (Press Ctrl+C to cancel at any",
      "time)",
      "",
      "",
      "Submitting application...",
      "",
      "✓ Application submitted successfully!",
      "",
      "Thanks for applying! We'll review your application and get back to you",
      "soon.",
      "",
      "In the meantime, check out our portfolio with tldr or learn",
      "more about the team with whois.",
    ]);
    expect(writtenLines(term)).toEqual([
      "INPUT UI: What's your name?",
      "INPUT UI: Email address",
      "INPUT UI: LinkedIn profile URL",
      "INPUT UI: GitHub username",
      "INPUT UI: Why Root? What makes you a great fit?",
    ]);
    expect(term.history).toEqual(["apply 1>application.txt"]);
    expect(env.window.dataLayer).toEqual([
      {
        event: "commandSent",
        command: "apply",
        args: "1>application.txt",
      },
    ]);
    expect(term.busy).toBe(false);
    expect(term.locked).toBe(false);
  });

  it("queues a live redirect behind a detached resize replay", async () => {
    const { getSessionFileLines, term } = loadIntegratedTerminal();
    await term.executeCommandLine("echo old>n", quiet);
    await term.executeCommandLine("cat n", quiet);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];

    let releaseReplay;
    const replayPending = new Promise((resolve) => {
      releaseReplay = resolve;
    });
    const executeCommandLine = term.executeCommandLine;
    let replayPaused = false;
    term.executeCommandLine = vi.fn(async (line, options) => {
      if (!replayPaused && options?.replayExecution) {
        replayPaused = true;
        await replayPending;
      }
      return executeCommandLine(line, options);
    });
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 70; });

    const resize = term.resizeListener();
    await vi.waitFor(() => expect(replayPaused).toBe(true));
    let liveWriteSettled = false;
    const liveWrite = term.executeCommandLine("echo newest>n", quiet);
    liveWrite.finally(() => { liveWriteSettled = true; });
    await Promise.resolve();
    expect(liveWriteSettled).toBe(false);

    releaseReplay();
    await Promise.all([resize, liveWrite]);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["newest"]);
    expect(term.history).toEqual([...historyBefore, "echo newest>n"]);
    expect(env.window.dataLayer).toEqual([
      ...analyticsBefore,
      { event: "commandSent", command: "echo", args: "newest>n" },
    ]);

    term.executeCommandLine = executeCommandLine;
    term.writeln.mockClear();
    await term.executeCommandLine("cat n", quiet);
    expect(writtenLines(term)).toEqual(["newest"]);
  });

  it("preserves live session files across clear and resize replay without repeating appends or analytics", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
    } = loadIntegratedTerminal();

    await term.executeCommandLine("echo a>n", quiet);
    await term.executeCommandLine("echo b>>n", quiet);
    await term.executeCommandLine("clear", quiet);
    await term.executeCommandLine("echo c>>n", quiet);

    expect(getSessionFileNames("/home/guest")).toEqual(["n"]);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["a", "b", "c"]);
    expect(term.history).toEqual(["echo c>>n"]);
    const analyticsBeforeResize = [...env.window.dataLayer];

    env.window.fitAddon.fit.mockImplementation(() => {
      term.cols = 80;
    });

    await term.resizeListener();
    expect(getSessionFileNames("/home/guest")).toEqual(["n"]);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["a", "b", "c"]);
    expect(env.window.dataLayer).toEqual(analyticsBeforeResize);

    env.window.fitAddon.fit.mockImplementation(() => {
      term.cols = 60;
    });
    await term.resizeListener();
    expect(getSessionFileNames("/home/guest")).toEqual(["n"]);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["a", "b", "c"]);
    expect(env.window.dataLayer).toEqual(analyticsBeforeResize);

    term.init.mockClear?.();
    await term.resizeListener();
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["a", "b", "c"]);
    expect(env.window.dataLayer).toEqual(analyticsBeforeResize);

    term.writeln.mockClear();
    await term.executeCommandLine("cat n", {
      addToHistory: false,
      promptAfter: false,
      showLeadingNewline: false,
      trackAnalytics: false,
      scrollAfter: false,
    });
    expect(writtenLines(term)).toEqual(["a", "b", "c"]);

    env.cleanup();
    env = null;
    const fresh = loadIntegratedTerminal();
    expect(fresh.getSessionFileNames("/home/guest")).toEqual([]);
  });

  it("replays each historical session read from its detached submission-time view", async () => {
    const { getSessionFileLines, getSessionFileNames, term } = loadIntegratedTerminal();

    await term.executeCommandLine("echo first>n", quiet);
    await term.executeCommandLine("cat n", quiet);
    await term.executeCommandLine("cat n|wc -l", quiet);
    await term.executeCommandLine("ls", quiet);
    await term.executeCommandLine("echo later>n", quiet);
    await term.executeCommandLine("echo side>z", quiet);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];

    term.writeln.mockClear();
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 70; });
    await term.resizeListener();

    expect(writtenLines(term)).toEqual(expect.arrayContaining([
      "first",
      "1",
      "id_rsa   welcome.htm   n",
    ]));
    expect(writtenLines(term)).not.toContain("id_rsa   welcome.htm   n   z");
    expect(getSessionFileNames("/home/guest")).toEqual(["n", "z"]);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["later"]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.writeln.mockClear();
    await term.executeCommandLine("echo last>>n", quiet);
    await term.executeCommandLine("cat n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["later", "last"]);
    expect(writtenLines(term)).toEqual(["later", "last"]);
  });

  it("replays prompt echoes in each entry's submission context and restores the live scope", async () => {
    const { getSessionFileLines, getSessionFileNames, term } = loadIntegratedTerminal();

    await term.executeCommandLine("cd /", quiet);
    await term.executeCommandLine("echo kept>n", quiet);
    await term.executeCommandLine("cat n", quiet);
    await term.executeCommandLine("upgrade >", quiet);
    await term.executeCommandLine("cd bin", quiet);
    await term.executeCommandLine("echo ordinary", quiet);
    await term.executeCommandLine("su root", quiet);
    await term.executeCommandLine("echo root>r", quiet);
    await term.executeCommandLine("cat r", quiet);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    const filesBefore = {
      rootDirectory: getSessionFileNames("/"),
      rootHome: getSessionFileLines("/home/root", "r"),
    };

    term.write.mockClear();
    term.writeln.mockClear();
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 70; });
    await term.resizeListener();

    const promptEchoes = term.write.mock.calls
      .map(([text]) => text.replace(/\u001b\[[0-9;]*m/g, ""))
      .filter((text) => text.includes("\r\n") && !text.endsWith(" $ "));
    expect(promptEchoes).toEqual([
      "\r\nguest:rootpc ~ $ cd /\r\n",
      "\r\nguest:rootpc / $ echo kept>n\r\n",
      "\r\nguest:rootpc / $ cat n\r\n",
      "\r\nguest:rootpc / $ upgrade >\r\n",
      "\r\nguest:rootpc / $ cd bin\r\n",
      "\r\nguest:rootpc bin $ echo ordinary\r\n",
      "\r\nguest:rootpc bin $ su root\r\n",
      "\r\nroot:rootpc ~ $ echo root>r\r\n",
      "\r\nroot:rootpc ~ $ cat r\r\n",
    ]);
    expect(writtenLines(term)).toEqual(expect.arrayContaining([
      "kept",
      "ordinary",
      "root",
    ]));
    // The rejected upgrade entry is prompt-only during replay because upgrade
    // is in NO_REPLAY; its exact prompt above proves it was retained without
    // rerunning the rejection branch.
    expect(writtenLines(term)).not.toContain("redirect: file name required");
    expect(term.user).toBe("root");
    expect(term.cwd).toBe("~");
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);
    expect(getSessionFileNames("/")).toEqual(filesBefore.rootDirectory);
    expect(getSessionFileLines("/home/root", "r")).toEqual(filesBefore.rootHome);

    term.write.mockClear();
    term.writeln.mockClear();
    await term.resizeListener();
    expect(term.write).not.toHaveBeenCalled();
    expect(term.writeln).not.toHaveBeenCalled();
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.writeln.mockClear();
    await term.executeCommandLine("echo last>>r", quiet);
    await term.executeCommandLine("cat r", quiet);
    expect(getSessionFileLines("/home/root", "r")).toEqual(["root", "last"]);
    expect(writtenLines(term)).toEqual(["root", "last"]);
  });

  it("restores historical scope after replay failure and keeps clear metadata aligned with live files", async () => {
    const { getSessionFileLines, getSessionFileNames, term } = loadIntegratedTerminal();

    await term.executeCommandLine("echo guest>n", quiet);
    await term.executeCommandLine("cat n", quiet);
    await term.executeCommandLine("su root", quiet);
    await term.executeCommandLine("echo root>n", quiet);
    await term.executeCommandLine("cat n", quiet);
    await term.executeCommandLine("echo nope>n extra", quiet);
    await term.executeCommandLine("cd /", quiet);
    await term.executeCommandLine("echo shared>r", quiet);
    await term.executeCommandLine("cat r", quiet);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];

    term.writeln.mockClear();
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 70; });
    await term.resizeListener();
    expect(writtenLines(term).filter((line) => [
      "guest",
      "root",
      "redirect: one file name required",
      "shared",
    ].includes(line))).toEqual([
      "guest",
      "root",
      "redirect: one file name required",
      "shared",
    ]);
    expect(term.user).toBe("root");
    expect(term.cwd).toBe("/");
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["guest"]);
    expect(getSessionFileLines("/home/root", "n")).toEqual(["root"]);
    expect(getSessionFileLines("/", "r")).toEqual(["shared"]);

    term.writeln.mockClear();
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 60; });
    await term.resizeListener();
    expect(writtenLines(term)).toEqual(expect.arrayContaining(["guest", "root", "shared"]));
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.writeln.mockClear();
    await term.resizeListener();
    expect(writtenLines(term)).toEqual([]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    const executeCommandLine = term.executeCommandLine;
    term.executeCommandLine = vi.fn(async (line, options) => {
      if (options?.addToHistory === false && line === "cat n") {
        throw new Error("replay failed");
      }
      return executeCommandLine(line, options);
    });
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 50; });
    await expect(term.resizeListener()).rejects.toThrow("replay failed");
    expect(term.user).toBe("root");
    expect(term.cwd).toBe("/");
    expect(getSessionFileNames("/")).toEqual(["r"]);
    expect(getSessionFileLines("/", "r")).toEqual(["shared"]);
    term.executeCommandLine = executeCommandLine;

    term.history.push("echo legacy");
    term.writeln.mockClear();
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 45; });
    await term.resizeListener();
    expect(writtenLines(term)).toContain("legacy");

    await term.executeCommandLine("clear", quiet);
    expect(term.history).toEqual([]);
    expect(getSessionFileLines("/", "r")).toEqual(["shared"]);
    term.writeln.mockClear();
    await term.executeCommandLine("cat r", quiet);
    await term.executeCommandLine("echo last>>r", quiet);
    expect(getSessionFileLines("/", "r")).toEqual(["shared", "last"]);

    term.writeln.mockClear();
    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 40; });
    await term.resizeListener();
    expect(writtenLines(term)).toContain("shared");
    expect(writtenLines(term)).not.toContain("last");
    expect(getSessionFileLines("/", "r")).toEqual(["shared", "last"]);

    term.writeln.mockClear();
    await term.executeCommandLine("cat r", quiet);
    expect(writtenLines(term)).toEqual(["shared", "last"]);
  });

  it("isolates home files across real su and cd transitions while sharing non-home directories", async () => {
    const {
      commands,
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
      _filesHere,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "n", ["guestline"]);
    writeSessionFile("/home/guest", "guestonly", ["guest"]);
    writeSessionFile("/home/root", "n", ["rootline"]);
    writeSessionFile("/bin", "binfile", ["shared"]);

    expect(term.user).toBe("guest");
    expect(term.cwd).toBe("~");
    expect(_filesHere()).toEqual([
      "id_rsa", "welcome.htm", "n", "guestonly",
    ]);
    commands.su(["root"]);
    expect(term.user).toBe("root");
    expect(term.cwd).toBe("~");
    expect(_filesHere()).toEqual(["id_rsa", "welcome.htm", "README.md", "n"]);
    term.writeln.mockClear();
    commands.cat(["n"]);
    expect(writtenLines(term)).toEqual(["rootline"]);

    commands.su(["guest"]);
    await term.executeCommandLine("echo second>>n", quiet);
    expect(getSessionFileLines("/home/guest", "n")).toEqual([
      "guestline", "second",
    ]);
    expect(getSessionFileLines("/home/root", "n")).toEqual(["rootline"]);
    term.writeln.mockClear();
    commands.grep(["guestline", "n"]);
    expect(writtenLines(term)).toEqual([
      "\u001b[1;35mguestline\u001b[0m",
      "second",
    ]);
    term.writeln.mockClear();
    await term.executeCommandLine("cat n|tail 1", quiet);
    await term.executeCommandLine("cat n|wc -l", quiet);
    expect(writtenLines(term)).toEqual(["second", "2"]);

    commands.cd(["/"]);
    commands.cd(["bin"]);
    expect(term.cwd).toBe("bin");
    expect(_filesHere()).toEqual(["zsh", "binfile"]);
    commands.su(["root"]);
    commands.cd(["/"]);
    commands.cd(["bin"]);
    expect(_filesHere()).toEqual(["zsh", "binfile"]);
    expect(getSessionFileNames("/home/guest")).toEqual(["n", "guestonly"]);
    expect(getSessionFileNames("/home/root")).toEqual(["n"]);
  });

  it("commits scope-changing producers to their submission-time directory", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "guestkeep", ["guest"]);
    writeSessionFile("/home/root", "rootkeep", ["root"]);
    writeSessionFile("/bin", "binkeep", ["bin"]);

    await term.executeCommandLine("cd /bin>m", quiet);
    expect(term.cwd).toBe("bin");
    expect(getSessionFileLines("/home/guest", "m")).toEqual([]);
    expect(getSessionFileLines("/bin", "m")).toBeNull();
    expect(getSessionFileNames("/home/guest")).toEqual(["guestkeep", "m"]);
    expect(getSessionFileLines("/home/root", "rootkeep")).toEqual(["root"]);
    expect(getSessionFileLines("/bin", "binkeep")).toEqual(["bin"]);

    await term.executeCommandLine("su root>n", quiet);
    expect(term.user).toBe("root");
    expect(term.cwd).toBe("~");
    expect(getSessionFileLines("/bin", "n")).toEqual([]);
    expect(getSessionFileLines("/home/root", "n")).toBeNull();
    expect(getSessionFileNames("/bin")).toEqual(["binkeep", "n"]);
    expect(getSessionFileLines("/home/guest", "guestkeep")).toEqual(["guest"]);

    term.writeln.mockClear();
    await term.executeCommandLine("cat rootkeep", quiet);
    expect(writtenLines(term)).toEqual(["root"]);
  });

  it("reads exact rows through every viewer, highlights whole-file grep, preserves built-ins, and feeds pipelines", async () => {
    const {
      commands,
      term,
      writeSessionFile,
      _insertFileToDOM,
    } = loadIntegratedTerminal();
    const rows = ["first <&>", "", 'needle "quoted"', "last &amp;"];
    writeSessionFile("/home/guest", "notes.txt", rows);
    writeSessionFile("/bin", "notes.txt", ["other directory"]);
    _insertFileToDOM("welcome.htm", "built-in <&>");

    for (const reader of ["cat", "head", "tail", "less", "more"]) {
      term.writeln.mockClear();
      commands[reader](["notes.txt"]);
      expect(writtenLines(term), reader).toEqual(rows);
    }

    term.writeln.mockClear();
    commands.grep(["needle", "notes.txt"]);
    expect(writtenLines(term)).toEqual([
      "first <&>",
      "",
      '\u001b[1;35mneedle\u001b[0m "quoted"',
      "last &amp;",
    ]);

    term.writeln.mockClear();
    commands.cat(["welcome.htm"]);
    expect(writtenLines(term)).toEqual(["built-in <&amp;>"]);
    expect(env.window.fetch).not.toHaveBeenCalled();

    term.writeln.mockClear();
    await term.executeCommandLine("cat notes.txt | tail 2", {
      addToHistory: false,
      promptAfter: false,
      showLeadingNewline: false,
      trackAnalytics: false,
      scrollAfter: false,
    });
    expect(writtenLines(term)).toEqual(['needle "quoted"', "last &amp;"]);

    term.writeln.mockClear();
    await term.executeCommandLine("cat notes.txt | wc -l", {
      addToHistory: false,
      promptAfter: false,
      showLeadingNewline: false,
      trackAnalytics: false,
      scrollAfter: false,
    });
    expect(writtenLines(term)).toEqual(["4"]);
  });

  it("distinguishes empty, blank, literal, and missing session files without preloading", () => {
    const { commands, term, writeSessionFile } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "empty", []);
    writeSessionFile("/home/guest", "blank", [""]);
    writeSessionFile("/home/guest", "literal", ['<tag> & "quoted" >']);

    commands.cat(["empty"]);
    expect(term.writeln).not.toHaveBeenCalled();
    expect(term.write).not.toHaveBeenCalled();
    expect(env.window.fetch).not.toHaveBeenCalled();

    commands.cat(["blank"]);
    expect(writtenLines(term)).toEqual([""]);

    term.writeln.mockClear();
    commands.cat(["literal"]);
    expect(writtenLines(term)).toEqual(['<tag> & "quoted" >']);

    term.writeln.mockClear();
    commands.cat(["missing"]);
    expect(writtenLines(term)).toEqual(["No such file: missing"]);
  });

  it("completes quoted and unquoted grep filenames through real keyboard handlers and dispatch", async () => {
    const { getSessionFileLines, term } = loadIntegratedTerminal({ withKeyboard: true });

    await term.executeCommandLine("echo hello world>notesx", quiet);
    expect(getSessionFileLines("/home/guest", "notesx")).toEqual(["hello world"]);
    expect(writtenLines(term)).toEqual([]);

    const type = (text) => {
      for (const character of text) term._onData(character);
    };
    const pressTab = () => term._customKeyHandler({
      altKey: false,
      ctrlKey: false,
      key: "Tab",
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
      type: "keydown",
    });

    type('grep "hello world" not');
    expect(term.currentLine).toBe('grep "hello world" not');
    pressTab();
    expect(term.currentLine).toBe('grep "hello world" notesx ');
    term.writeln.mockClear();
    term._onData("\r");
    await vi.waitFor(() => {
      expect(writtenLines(term)).toEqual(["", "hello world\u001b[0;38m"]);
      expect(term.busy).toBe(false);
    });

    type("grep hello not");
    expect(term.currentLine).toBe("grep hello not");
    pressTab();
    expect(term.currentLine).toBe("grep hello notesx ");
    term.writeln.mockClear();
    term._onData("\r");
    await vi.waitFor(() => {
      expect(writtenLines(term)).toEqual(["", "hello\u001b[0;38m world"]);
      expect(term.busy).toBe(false);
    });
  });

  it("keeps cd on built-in candidates while real reader completion still executes scoped session files", async () => {
    const {
      _builtInFilesHere,
      _filesHere,
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
    } = loadIntegratedTerminal({ withKeyboard: true });

    await term.executeCommandLine("cd /", quiet);
    const baselineBuiltIns = _builtInFilesHere();
    expect(baselineBuiltIns).toEqual(["bin", "home"]);
    await term.executeCommandLine("echo x>bill", quiet);
    await term.executeCommandLine("echo y>budget", quiet);
    writeSessionFile("/bin", "bill", ["other directory"]);
    expect(_builtInFilesHere()).toEqual(baselineBuiltIns);
    expect(_filesHere()).toEqual(["bin", "home", "bill", "budget"]);

    const type = (text) => {
      for (const character of text) term._onData(character);
    };
    const pressTab = () => term._customKeyHandler({
      altKey: false,
      ctrlKey: false,
      key: "Tab",
      metaKey: false,
      preventDefault: vi.fn(),
      shiftKey: false,
      type: "keydown",
    });
    const enterAndWait = async () => {
      term._onData("\r");
      await vi.waitFor(() => expect(term.busy).toBe(false));
    };

    type("cd b");
    pressTab();
    expect(term.currentLine).toBe("cd bin ");
    await enterAndWait();
    expect(term.cwd).toBe("bin");
    term.writeln.mockClear();
    await term.executeCommandLine("pwd", quiet);
    expect(writtenLines(term)).toEqual(["/bin"]);

    await term.executeCommandLine("cd /", quiet);
    for (const reader of ["cat", "head", "tail", "less", "more"]) {
      type(`${reader} bil`);
      pressTab();
      expect(term.currentLine).toBe(`${reader} bill `);
      term.writeln.mockClear();
      await enterAndWait();
      expect(writtenLines(term)).toEqual(["", "x"]);
    }

    type("grep x bil");
    pressTab();
    expect(term.currentLine).toBe("grep x bill ");
    term.writeln.mockClear();
    await enterAndWait();
    expect(writtenLines(term)).toEqual(["", "x\u001b[0;38m"]);

    term.writeln.mockClear();
    await term.executeCommandLine("ls", quiet);
    expect(writtenLines(term)).toEqual(["bin   home   bill   budget"]);
    expect(getSessionFileLines("/", "bill")).toEqual(["x"]);
    expect(getSessionFileNames("/")).toEqual(["bill", "budget"]);
    expect(getSessionFileLines("/bin", "bill")).toEqual(["other directory"]);
  });

  it("retains redirected reset history and metadata through real keyboard recall", async () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      term,
    } = loadIntegratedTerminal({
      withKeyboard: true,
      retainProductionInitializer: true,
    });
    term.writeln.mockClear();
    term.write.mockClear();
    env.window.dataLayer = [];

    await term.executeCommandLine("echo kept>n", quiet);
    await term.executeCommandLine("clear>c", quiet);

    const resetRows = getSessionFileLines("/home/guest", "c");
    expect(resetRows).toEqual(expect.arrayContaining([
      "Welcome to the Root Ventures terminal. Seeding bold engineers!",
    ]));
    expect(resetRows.some((line) => line.includes("help") && line.includes("exit"))).toBe(true);
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["kept"]);
    expect(getSessionFileNames("/home/guest")).toEqual(["n", "c"]);
    expect(term.history).toEqual(["echo kept>n", "clear>c"]);
    expect(env.window.dataLayer).toEqual([
      { args: "kept>n", command: "echo", event: "commandSent" },
      { args: "", command: "clear>c", event: "commandSent" },
    ]);

    term._onData("\u001b[A");
    expect(term.currentLine).toBe("clear>c");
    expect(term.history).toEqual(["echo kept>n", "clear>c"]);
    expect(env.window.dataLayer).toHaveLength(2);
    term._onData("\u0003");
    expect(term.currentLine).toBe("");
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["kept"]);
    expect(getSessionFileLines("/home/guest", "c")).toEqual(resetRows);
  });

  it("scopes reset-history preservation to redirected producers on success and failure", async () => {
    const {
      commands,
      getSessionFileLines,
      term,
    } = loadIntegratedTerminal();
    env.window.dataLayer = [];

    await term.executeCommandLine("clear|head 1>first", quiet);
    expect(term.history).toEqual(["clear|head 1>first"]);
    expect(getSessionFileLines("/home/guest", "first")).toHaveLength(1);

    await term.executeCommandLine("alias wipe=clear", quiet);
    await term.executeCommandLine("wipe>>first", quiet);
    const filesBeforeResize = getSessionFileLines("/home/guest", "first");
    const historyBeforeResize = [...term.history];
    const analyticsBeforeResize = [...env.window.dataLayer];
    expect(filesBeforeResize.length).toBeGreaterThan(1);
    expect(historyBeforeResize).toEqual([
      "clear|head 1>first",
      "alias wipe=clear",
      "wipe>>first",
    ]);

    env.window.fitAddon.fit.mockImplementation(() => { term.cols = 70; });
    await term.resizeListener();
    expect(term.history).toEqual(historyBeforeResize);
    expect(env.window.dataLayer).toEqual(analyticsBeforeResize);
    expect(getSessionFileLines("/home/guest", "first")).toEqual(filesBeforeResize);

    commands.resetfail = () => {
      term.init();
      throw new Error("reset failed");
    };
    await term.executeCommandLine("resetfail>failed", quiet);
    expect(term.history).toEqual([...historyBeforeResize, "resetfail>failed"]);
    expect(getSessionFileLines("/home/guest", "failed")).toBe(null);
    expect(getSessionFileLines("/home/guest", "first")).toEqual(filesBeforeResize);

    const eventCountAfterFailure = env.window.dataLayer.length;
    await term.executeCommandLine("echo after>live", quiet);
    expect(getSessionFileLines("/home/guest", "live")).toEqual(["after"]);
    expect(env.window.dataLayer).toHaveLength(eventCountAfterFailure + 1);

    commands.zsh([]);
    expect(term.history).toEqual([]);
    expect(getSessionFileLines("/home/guest", "first")).toEqual(filesBeforeResize);
    expect(getSessionFileLines("/home/guest", "live")).toEqual(["after"]);
  });

  it("lists built-ins before session creation order, isolates directories, and leaves rm and touch inert", () => {
    const {
      commands,
      getSessionFileLines,
      getSessionFileNames,
      term,
      writeSessionFile,
      _filesHere,
    } = loadIntegratedTerminal();
    writeSessionFile("/home/guest", "z", ["z one"]);
    writeSessionFile("/home/guest", "a", ["a one"]);
    writeSessionFile("/bin", "z", ["bin z"]);
    writeSessionFile("/home/guest", "z", ["z replacement"]);
    writeSessionFile("/home/guest", "a", ["a two"], true);

    expect(_filesHere()).toEqual(["id_rsa", "welcome.htm", "z", "a"]);
    commands.ls([]);
    expect(writtenLines(term)).toEqual(["id_rsa   welcome.htm   z   a"]);

    term.writeln.mockClear();
    commands.rm(["z"]);
    commands.touch(["new"]);
    expect(writtenLines(term)).toEqual([
      "I'm sorry Dave, I'm afraid I can't do that.",
      "You can't \u001b[1;35mtouch\u001b[0m this",
    ]);
    expect(getSessionFileNames("/home/guest")).toEqual(["z", "a"]);
    expect(getSessionFileLines("/home/guest", "z")).toEqual(["z replacement"]);
    expect(getSessionFileLines("/home/guest", "a")).toEqual(["a one", "a two"]);

    term.cwd = "bin";
    expect(_filesHere()).toEqual(["zsh", "z"]);
    expect(getSessionFileLines("/bin", "z")).toEqual(["bin z"]);
    term.writeln.mockClear();
    commands.cat(["a"]);
    expect(writtenLines(term)).toEqual(["No such file: a"]);

    term.cwd = "~";
    term.writeln.mockClear();
    commands.cat(["z"]);
    expect(writtenLines(term)).toEqual(["z replacement"]);
  });
});

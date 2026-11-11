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

function loadProductionTerminal(term = createTerm(), globals = {}, hash = "") {
  env = createBrowserEnv({
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      _filesHere: () => [],
      buildInfo: Object.freeze({ version: "test", buildDate: "2030-01-01" }),
      colorText: (text, color) => color ? `<${color}>${text}</${color}>` : text,
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
      ...globals,
    },
  });
  env.window.location.hash = hash;
  env.loadScripts(["js/pipeline.js", "config/commands.js", "js/terminal-ext.js"]);
  const { extend } = env.exportValues(["extend"]);
  extend(term);
  term.preloadCommandAssets = vi.fn(() => Promise.resolve());
  return term;
}

function plainExecutionOptions(extra = {}) {
  return {
    promptAfter: false,
    showLeadingNewline: false,
    scrollAfter: false,
    ...extra,
  };
}

function exactWrites(term, value) {
  return term.writeln.mock.calls.filter(([line]) => line === value).length;
}

function installCursorAdapter(term) {
  let cursorX = 0;
  Object.defineProperty(term.buffer.active, "cursorX", {
    configurable: true,
    get: () => cursorX,
  });
  const update = (value) => {
    const source = String(value);
    for (let index = 0; index < source.length;) {
      if (source[index] === "\x1b") {
        const match = source.slice(index).match(/^\x1b\[([0-9]*)([A-Za-z])/);
        if (match) {
          const count = Number(match[1] || 1);
          if (match[2] === "D") cursorX = Math.max(0, cursorX - count);
          else if (match[2] === "C") cursorX += count;
          index += match[0].length;
          continue;
        }
      }
      if (source[index] === "\r") cursorX = 0;
      else if (source[index] !== "\n") cursorX += 1;
      index += 1;
    }
  };
  term.write = vi.fn(update);
  term.writeln = vi.fn((value = "") => {
    update(value);
    cursorX = 0;
  });
  term.reset = vi.fn(() => {
    cursorX = 0;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("history expansion production integration", () => {
  it("prints one plain expansion row and records the expanded lexical command once", async () => {
    const term = loadProductionTerminal();
    const stylePrint = vi.spyOn(term, "stylePrint");

    await term.executeCommandLine("echo a", plainExecutionOptions());
    term.writeln.mockClear();
    stylePrint.mockClear();
    await term.executeCommandLine("!!", {
      promptAfter: false,
      scrollAfter: false,
    });

    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["", "echo a", "a"]);
    expect(term.writeln).toHaveBeenCalledWith("echo a");
    expect(term.writeln).toHaveBeenCalledWith("a");
    expect(term.history).toEqual(["echo a", "echo a"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "a" },
      { event: "commandSent", command: "echo", args: "a" },
    ]);

    term.writeln.mockClear();
    await term.executeCommandLine("echo !! !!", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo echo a echo a",
      "echo a echo a",
    ]);
    expect(term.history.at(-1)).toBe("echo echo a echo a");

    await term.executeCommandLine("echo '%help%'", plainExecutionOptions());
    term.writeln.mockClear();
    stylePrint.mockClear();
    await term.executeCommandLine("!!", plainExecutionOptions());
    expect(term.writeln.mock.calls[0][0]).toBe("echo '%help%'");
    expect(stylePrint).not.toHaveBeenCalledWith("echo '%help%'");
    expect(term.writeln.mock.calls[1][0]).toContain("<command>help</command>");
  });

  it("preserves backslash-prefixed apostrophe spans through real dispatch and later expansion", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo seed", plainExecutionOptions());
    term.writeln.mockClear();

    const submitted = String.raw`echo \'!!\'`;
    await term.executeCommandLine(submitted, plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["\\!!\\"]);
    expect(term.history).toEqual(["echo seed", submitted]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "\\!!\\",
    });

    term.writeln.mockClear();
    await term.executeCommandLine("!!", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      submitted,
      "\\!!\\",
    ]);
    expect(term.history).toEqual(["echo seed", submitted, submitted]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "\\!!\\",
    });

    term.writeln.mockClear();
    await term.executeCommandLine("echo ok", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["ok"]);
  });

  it("keeps protected apostrophe spans isolated from later expandable events", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo seed", plainExecutionOptions());
    term.writeln.mockClear();

    const submitted = String.raw`echo \'!!\' !!`;
    const expanded = String.raw`echo \'!!\' echo seed`;
    await term.executeCommandLine(submitted, plainExecutionOptions());

    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      expanded,
      String.raw`\!!\ echo seed`,
    ]);
    expect(term.history.at(-1)).toBe(expanded);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: String.raw`\!!\ echo seed`,
    });
  });

  it("preserves parser quote state after a backslash-prefixed double quote", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo seed", plainExecutionOptions());
    term.writeln.mockClear();

    const submitted = String.raw`echo "\"'" !!`;
    await term.executeCommandLine(submitted, plainExecutionOptions());

    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([String.raw`\" !!`]);
    expect(term.history.at(-1)).toBe(submitted);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: String.raw`\" !!`,
    });
  });

  it("feeds expanded aliases, current variables and pipelines through production consumers", async () => {
    const term = loadProductionTerminal();

    await term.executeCommandLine("alias r=echo alias", plainExecutionOptions());
    await term.executeCommandLine("r tail", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!r", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["r tail", "alias tail"]);
    expect(term.history.at(-1)).toBe("r tail");
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "r",
      args: "tail",
    });

    await term.executeCommandLine("export NAME=before", plainExecutionOptions());
    await term.executeCommandLine("echo $NAME", plainExecutionOptions());
    await term.executeCommandLine("export NAME=after", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!echo", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo $NAME",
      "after",
    ]);
    expect(term.history.at(-1)).toBe("echo $NAME");
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "$NAME",
    });

    await term.executeCommandLine("echo a", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!!|wc -l", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo a|wc -l",
      "1",
    ]);
    expect(term.history.at(-1)).toBe("echo a|wc -l");
  });

  it("never re-expands text introduced by aliases, variables, history or substitution", async () => {
    const term = loadProductionTerminal();

    await term.executeCommandLine("alias bang=echo '!!'", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("bang", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["!!"]);

    await term.executeCommandLine("export B='!!'", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("echo $B", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["!!"]);

    await term.executeCommandLine("echo '!!'", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!!", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo '!!'",
      "!!",
    ]);

    await term.executeCommandLine("echo old", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("^old^!!", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo !!",
      "!!",
    ]);
    expect(term.writeln).not.toHaveBeenCalledWith(expect.stringContaining("event not found"));
  });

  it.each([
    { history: [], line: "!!", diagnostic: "!!: event not found" },
    { history: ["echo seed"], line: "echo !9999", diagnostic: "!9999: event not found" },
    { history: ["echo seed"], line: "echo !-2", diagnostic: "!-2: event not found" },
    { history: ["echo seed"], line: "echo !missing", diagnostic: "!missing: event not found" },
    { history: ["echo seed"], line: "echo !! !9999 !missing", diagnostic: "!9999: event not found" },
    { history: ["echo seed"], line: "echo !9999 | wc -l", diagnostic: "!9999: event not found" },
  ])("atomically rejects $line and accepts the next command", async ({ history, line, diagnostic }) => {
    const term = loadProductionTerminal();
    term.history = [...history];
    env.window.dataLayer = [{ event: "prior", command: "keep", args: "state" }];
    term.defineAlias("keep", "echo alias");
    term.environment.set("KEEP", "value");
    const stateBefore = {
      history: [...term.history],
      analytics: [...env.window.dataLayer],
      aliases: term.getAliases(),
      environment: term.environment.entries(),
    };
    const dispatch = vi.spyOn(term, "dispatchCommand");
    term.preloadCommandAssets.mockClear();
    term.writeln.mockClear();

    await term.executeCommandLine(line, plainExecutionOptions());

    expect(term.writeln.mock.calls.map(([output]) => output)).toEqual([diagnostic]);
    expect(term.preloadCommandAssets).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history).toEqual(stateBefore.history);
    expect(env.window.dataLayer).toEqual(stateBefore.analytics);
    expect(term.getAliases()).toEqual(stateBefore.aliases);
    expect(term.environment.entries()).toEqual(stateBefore.environment);
    expect(term.busy).toBe(false);

    await term.executeCommandLine("echo ok", plainExecutionOptions());
    expect(term.writeln).toHaveBeenLastCalledWith("ok");
    expect(term.history).toEqual([...stateBefore.history, "echo ok"]);
    expect(env.window.dataLayer).toEqual([
      ...stateBefore.analytics,
      { event: "commandSent", command: "echo", args: "ok" },
    ]);
  });

  it.each([
    { history: [], line: "^a^b" },
    { history: ["echo a"], line: "^^b" },
    { history: ["echo a"], line: "^missing^b" },
  ])("atomically rejects failed substitution $line and accepts the next command", async ({ history, line }) => {
    const term = loadProductionTerminal();
    term.history = [...history];
    env.window.dataLayer = [{ event: "prior", command: "keep", args: "state" }];
    const dispatch = vi.spyOn(term, "dispatchCommand");
    term.preloadCommandAssets.mockClear();
    term.writeln.mockClear();

    await term.executeCommandLine(line, plainExecutionOptions());

    expect(term.writeln.mock.calls.map(([output]) => output)).toEqual(["substitution failed"]);
    expect(term.preloadCommandAssets).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history).toEqual(history);
    expect(env.window.dataLayer).toEqual([{ event: "prior", command: "keep", args: "state" }]);
    expect(term.busy).toBe(false);

    await term.executeCommandLine("echo ok", plainExecutionOptions());
    expect(term.writeln).toHaveBeenLastCalledWith("ok");
    expect(term.history).toEqual([...history, "echo ok"]);
  });

  it("preserves standalone, valid-pipeline and invalid-pipeline branches after expansion", async () => {
    const term = loadProductionTerminal();

    await term.executeCommandLine("export U=z", plainExecutionOptions());
    await term.executeCommandLine("echo $U", plainExecutionOptions());
    expect(term.writeln).toHaveBeenLastCalledWith("z");

    await term.executeCommandLine("echo d", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!!|wc -l", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["echo d|wc -l", "1"]);

    await term.executeCommandLine("echo d", plainExecutionOptions());
    term.writeln.mockClear();
    const dispatch = vi.spyOn(term, "dispatchCommand");
    await term.executeCommandLine("!!|head 0", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo d|head 0",
      "head: count must be a positive base-10 integer",
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history.at(-1)).toBe("echo d|head 0");
  });

  it("composes production Enter and ArrowUp with expanded lexical history", async () => {
    const term = createTerm({
      _initialized: false,
      busy: false,
      locked: false,
      historyCursor: -1,
      attachCustomKeyEventHandler: vi.fn((handler) => { term._customKeyHandler = handler; }),
      onData: vi.fn((handler) => { term._onData = handler; return { dispose: vi.fn() }; }),
    });
    installCursorAdapter(term);
    loadProductionTerminal(term);
    env.loadScript("js/terminal.js");
    const { runRootTerminal } = env.exportValues(["runRootTerminal"]);
    runRootTerminal(term);

    for (const character of "echo a") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo a"]));
    for (const character of "!!") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo a", "echo a"]));

    const expansionRowsBeforeRecall = exactWrites(term, "echo a");
    term._onData("\x1b[A");
    expect(term.currentLine).toBe("echo a");
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo a", "echo a", "echo a"]));
    expect(exactWrites(term, "echo a")).toBe(expansionRowsBeforeRecall);
    expect(exactWrites(term, "a")).toBe(3);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "a" },
      { event: "commandSent", command: "echo", args: "a" },
      { event: "commandSent", command: "echo", args: "a" },
    ]);
  });

  it("replays expanded lexical history at repeated widths without expansion rows or side effects", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo '!!'", plainExecutionOptions());
    await term.executeCommandLine("!!", plainExecutionOptions());
    await term.executeCommandLine("!!|wc -l", plainExecutionOptions());
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.runDeepLink = vi.fn(() => Promise.resolve());
    term.init = vi.fn((_user, preserveHistory) => {
      expect(preserveHistory).toBe(true);
    });

    for (const width of [40, 80]) {
      env.window.fitAddon.fit = vi.fn(() => { term.cols = width; });
      term.writeln.mockClear();
      await term.resizeListener();
      expect(exactWrites(term, "!!")).toBe(2);
      expect(exactWrites(term, "1")).toBe(1);
      expect(exactWrites(term, "echo '!!'")).toBe(0);
      expect(exactWrites(term, "echo '!!'|wc -l")).toBe(0);
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);
    }

    term.writeln.mockClear();
    await term.executeCommandLine("echo z", plainExecutionOptions());
    expect(term.writeln).toHaveBeenLastCalledWith("z");
    expect(term.history).toEqual([...historyBefore, "echo z"]);
  });

  it("records a successful empty quick substitution without dispatching an empty command", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("x", plainExecutionOptions());
    const dispatch = vi.spyOn(term, "dispatchCommand");
    dispatch.mockClear();
    term.writeln.mockClear();

    await term.executeCommandLine("^x^", { scrollAfter: false });

    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["", ""]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history).toEqual(["x", ""]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "x", args: "" },
      { event: "commandSent", command: "", args: "" },
    ]);
    expect(term.currentLine).toBe("");
    expect(term.busy).toBe(false);
  });

  it.each(["!!", "!1001", "!-1"])(
    "keeps an empty expanded entry referenceable through %s",
    async (reference) => {
      const term = loadProductionTerminal();
      await term.executeCommandLine("echo x", plainExecutionOptions());
      await term.executeCommandLine("^echo x^", plainExecutionOptions());
      const dispatch = vi.spyOn(term, "dispatchCommand");
      dispatch.mockClear();
      term.writeln.mockClear();

      await term.executeCommandLine(reference, plainExecutionOptions());

      expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([""]);
      expect(dispatch).not.toHaveBeenCalled();
      expect(term.history).toEqual(["echo x", "", ""]);
      expect(env.window.dataLayer.at(-1)).toEqual({
        event: "commandSent",
        command: "",
        args: "",
      });
    }
  );

  it.each([
    { addToHistory: false, trackAnalytics: true },
    { addToHistory: true, trackAnalytics: false },
    { addToHistory: false, trackAnalytics: false },
  ])(
    "respects independent recording options for an empty expansion: %o",
    async ({ addToHistory, trackAnalytics }) => {
      const term = loadProductionTerminal();
      await term.executeCommandLine("echo x", plainExecutionOptions());
      const analyticsBefore = [...env.window.dataLayer];

      await term.executeCommandLine(
        "^echo x^",
        plainExecutionOptions({ addToHistory, trackAnalytics })
      );

      expect(term.history).toEqual(addToHistory ? ["echo x", ""] : ["echo x"]);
      expect(env.window.dataLayer).toEqual(
        trackAnalytics
          ? [...analyticsBefore, { event: "commandSent", command: "", args: "" }]
          : analyticsBefore
      );
    }
  );

  it("records the exact raw whitespace expansion text without empty dispatch", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo UNIQUE42", plainExecutionOptions());
    const dispatch = vi.spyOn(term, "dispatchCommand");
    dispatch.mockClear();
    term.writeln.mockClear();

    await term.executeCommandLine("^echo UNIQUE42^   ", plainExecutionOptions());

    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["   "]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history).toEqual(["echo UNIQUE42", "   "]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "",
      args: "",
    });
  });

  it("records exact leading, trailing and repeated internal whitespace while retaining parsed execution", async () => {
    const term = loadProductionTerminal();

    await term.executeCommandLine("echo left", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("^echo left^  echo lead  ", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "  echo lead  ",
      "lead",
    ]);
    expect(term.history.at(-1)).toBe("  echo lead  ");
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "lead",
    });

    await term.executeCommandLine("echo gap", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("^gap^a   b", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo a   b",
      "a b",
    ]);
    expect(term.history.at(-1)).toBe("echo a   b");

    await term.executeCommandLine("echo plain", plainExecutionOptions());
    await term.executeCommandLine("!!", plainExecutionOptions());
    expect(term.history.at(-1)).toBe("echo plain");
  });

  it("uses the exact expanded line in standalone and both pipeline recording branches", async () => {
    const term = loadProductionTerminal();

    await term.executeCommandLine("echo d", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!!   ", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual(["echo d   ", "d"]);
    expect(term.history.at(-1)).toBe("echo d   ");

    await term.executeCommandLine("echo d", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!!|wc -l   ", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo d|wc -l   ",
      "1",
    ]);
    expect(term.history.at(-1)).toBe("echo d|wc -l   ");

    await term.executeCommandLine("echo d", plainExecutionOptions());
    const dispatch = vi.spyOn(term, "dispatchCommand");
    dispatch.mockClear();
    term.writeln.mockClear();
    await term.executeCommandLine("!!|head 0   ", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo d|head 0   ",
      "head: count must be a positive base-10 integer",
    ]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history.at(-1)).toBe("echo d|head 0   ");
  });

  it.each([
    { addToHistory: false, trackAnalytics: true },
    { addToHistory: true, trackAnalytics: false },
    { addToHistory: false, trackAnalytics: false },
  ])(
    "preserves whitespace identity with independent recording options: %o",
    async ({ addToHistory, trackAnalytics }) => {
      const term = loadProductionTerminal();
      await term.executeCommandLine("echo x", plainExecutionOptions());
      const analyticsBefore = [...env.window.dataLayer];

      await term.executeCommandLine(
        "^x^a   ",
        plainExecutionOptions({ addToHistory, trackAnalytics })
      );

      expect(term.history).toEqual(
        addToHistory ? ["echo x", "echo a   "] : ["echo x"]
      );
      expect(env.window.dataLayer).toEqual(
        trackAnalytics
          ? [
              ...analyticsBefore,
              { event: "commandSent", command: "echo", args: "a" },
            ]
          : analyticsBefore
      );
    }
  );

  it("keeps exact whitespace in references and skips leading-space entries for prefix lookup", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo x", plainExecutionOptions());
    await term.executeCommandLine("^x^a   ", plainExecutionOptions());

    for (const reference of ["!!", "!1001", "!-1"]) {
      await term.executeCommandLine(reference, plainExecutionOptions());
      expect(term.history.at(-1)).toBe("echo a   ");
    }

    await term.executeCommandLine("echo lead", plainExecutionOptions());
    await term.executeCommandLine("^echo lead^  echo hidden", plainExecutionOptions());
    term.writeln.mockClear();
    await term.executeCommandLine("!echo", plainExecutionOptions());
    expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([
      "echo lead",
      "lead",
    ]);
    expect(term.history.at(-1)).toBe("echo lead");
  });

  it("recalls an empty expanded entry without recording ordinary blank submissions", async () => {
    const term = createTerm({
      _initialized: false,
      busy: false,
      locked: false,
      historyCursor: -1,
      attachCustomKeyEventHandler: vi.fn((handler) => { term._customKeyHandler = handler; }),
      onData: vi.fn((handler) => { term._onData = handler; return { dispose: vi.fn() }; }),
    });
    installCursorAdapter(term);
    loadProductionTerminal(term);
    env.loadScript("js/terminal.js");
    const { runRootTerminal } = env.exportValues(["runRootTerminal"]);
    runRootTerminal(term);

    for (const character of "echo x") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo x"]));
    for (const character of "^echo x^") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo x", ""]));

    const analyticsBefore = [...env.window.dataLayer];
    const dispatch = vi.spyOn(term, "dispatchCommand");
    dispatch.mockClear();
    term.preloadCommandAssets.mockClear();
    term._onData("\x1b[A");
    expect(term.currentLine).toBe("");
    expect(term.historyCursor).toBe(0);
    term._onData("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    expect(term.preloadCommandAssets).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history).toEqual(["echo x", ""]);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    for (const character of "   ") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    expect(term.preloadCommandAssets).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(term.history).toEqual(["echo x", ""]);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    for (const character of "echo ok") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo x", "", "echo ok"]));
    expect(term.writeln).toHaveBeenCalledWith("ok");
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "ok",
    });
  });

  it("recalls exact expanded whitespace through the production keyboard and numbered history", async () => {
    const term = createTerm({
      _initialized: false,
      busy: false,
      locked: false,
      historyCursor: -1,
      attachCustomKeyEventHandler: vi.fn((handler) => { term._customKeyHandler = handler; }),
      onData: vi.fn((handler) => { term._onData = handler; return { dispose: vi.fn() }; }),
    });
    installCursorAdapter(term);
    loadProductionTerminal(term);
    const stylePrint = vi.spyOn(term, "stylePrint");
    env.loadScript("js/terminal.js");
    const { runRootTerminal } = env.exportValues(["runRootTerminal"]);
    runRootTerminal(term);
    const submit = async (line, expectedLength) => {
      for (const character of line) term._onData(character);
      term._onData("\r");
      await vi.waitFor(() => expect(term.history).toHaveLength(expectedLength));
    };

    await submit("echo x", 1);
    await submit("^x^a   ", 2);
    term._onData("\x1b[A");
    expect(term.currentLine).toBe("echo a   ");
    term._onData("b");
    expect(term.currentLine).toBe("echo a   b");
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toHaveLength(3));
    expect(term.writeln).toHaveBeenCalledWith("a b");

    await submit("echo y", 4);
    await submit("^echo y^   ", 5);
    term._onData("\x1b[A");
    expect(term.currentLine).toBe("   ");
    for (const character of "echo z") term._onData(character);
    expect(term.currentLine).toBe("   echo z");
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toHaveLength(6));
    expect(term.writeln).toHaveBeenCalledWith("z");

    await submit("history", 7);
    expect(term.stylePrint).toHaveBeenCalledWith("1001  echo a   ");
    expect(term.stylePrint).toHaveBeenCalledWith("1004     ");
  });

  it("replays exact whitespace-bearing history without re-expansion or recording", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo x", plainExecutionOptions());
    await term.executeCommandLine("^echo x^   ", plainExecutionOptions());
    await term.executeCommandLine("echo a", plainExecutionOptions());
    await term.executeCommandLine("^echo a^  echo b  ", plainExecutionOptions());
    await term.executeCommandLine("echo c", plainExecutionOptions());
    await term.executeCommandLine("!!|wc -l  ", plainExecutionOptions());
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.runDeepLink = vi.fn(() => Promise.resolve());
    term.init = vi.fn((_user, preserveHistory) => {
      expect(preserveHistory).toBe(true);
    });

    for (const width of [40, 80]) {
      env.window.fitAddon.fit = vi.fn(() => { term.cols = width; });
      const prompt = vi.spyOn(term, "prompt");
      prompt.mockClear();
      term.writeln.mockClear();
      await term.resizeListener();
      for (const line of historyBefore) {
        expect(prompt.mock.calls.filter((args) => args[1] === ` ${line}\r\n`)).toHaveLength(1);
      }
      expect(exactWrites(term, "   ")).toBe(0);
      expect(exactWrites(term, "  echo b  ")).toBe(0);
      expect(exactWrites(term, "echo c|wc -l  ")).toBe(0);
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);
      prompt.mockRestore();
    }

    await term.executeCommandLine("echo z", plainExecutionOptions());
    expect(term.writeln).toHaveBeenLastCalledWith("z");
    expect(term.history).toEqual([...historyBefore, "echo z"]);
  });

  it("replays an empty expanded entry without expansion or recording side effects", async () => {
    const term = loadProductionTerminal();
    await term.executeCommandLine("echo x", plainExecutionOptions());
    await term.executeCommandLine("^echo x^", plainExecutionOptions());
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    term.runDeepLink = vi.fn(() => Promise.resolve());
    term.init = vi.fn((_user, preserveHistory) => {
      expect(preserveHistory).toBe(true);
    });

    for (const width of [40, 80]) {
      env.window.fitAddon.fit = vi.fn(() => { term.cols = width; });
      const prompt = vi.spyOn(term, "prompt");
      prompt.mockClear();
      term.writeln.mockClear();
      await term.resizeListener();
      expect(prompt.mock.calls.filter((args) => args[1] === " echo x\r\n")).toHaveLength(1);
      expect(prompt.mock.calls.filter((args) => args[1] === " \r\n")).toHaveLength(1);
      expect(exactWrites(term, "x")).toBe(1);
      expect(term.history).toEqual(historyBefore);
      expect(env.window.dataLayer).toEqual(analyticsBefore);
      prompt.mockRestore();
    }

    await term.executeCommandLine("echo z", plainExecutionOptions());
    expect(term.writeln).toHaveBeenLastCalledWith("z");
    expect(term.history).toEqual([...historyBefore, "echo z"]);
  });

  it.each([
    ["#echo-!!", "!!"],
    ["#echo-!1000", "!1000"],
    ["#echo-!-1", "!-1"],
    ["#echo-!echo", "!echo"],
    ["#echo-^a^b", "^a^b"],
  ])(
    "dispatches the deep link %s literally with empty and populated history",
    async (hash, literal) => {
      for (const existingHistory of [[], ["echo prior"]]) {
        const term = loadProductionTerminal(createTerm(), {}, hash);
        term.history = [...existingHistory];

        await term.runDeepLink();

        expect(term.writeln.mock.calls.map(([line]) => line)).toEqual([literal]);
        expect(term.history).toEqual(existingHistory);
        expect(env.window.dataLayer).toEqual([
          { event: "commandSent", command: "echo", args: literal },
        ]);
        env.cleanup();
        env = null;
      }
    }
  );

  it("replays a literal bang deep link without recording or re-expanding it", async () => {
    const term = loadProductionTerminal(createTerm(), {}, "#echo-!!");
    await term.runDeepLink();
    const historyAfterArrival = [...term.history];
    const analyticsAfterArrival = [...env.window.dataLayer];

    expect(exactWrites(term, "!!")).toBe(1);
    expect(historyAfterArrival).toEqual([]);
    expect(analyticsAfterArrival).toEqual([
      { event: "commandSent", command: "echo", args: "!!" },
    ]);

    for (const width of [40, 80]) {
      env.window.fitAddon.fit = vi.fn(() => { term.cols = width; });
      term.writeln.mockClear();
      await term.resizeListener();

      expect(exactWrites(term, "!!")).toBe(1);
      expect(term.writeln).not.toHaveBeenCalledWith("!!: event not found");
      expect(term.history).toEqual(historyAfterArrival);
      expect(env.window.dataLayer).toEqual(analyticsAfterArrival);
    }
  });

  it("keeps interactive expansion enabled after a literal deep link and replay", async () => {
    const term = createTerm({
      _initialized: false,
      busy: false,
      locked: false,
      historyCursor: -1,
      attachCustomKeyEventHandler: vi.fn((handler) => { term._customKeyHandler = handler; }),
      onData: vi.fn((handler) => { term._onData = handler; return { dispose: vi.fn() }; }),
    });
    installCursorAdapter(term);
    loadProductionTerminal(term, {}, "#echo-!!");
    env.loadScript("js/terminal.js");
    const { runRootTerminal } = env.exportValues(["runRootTerminal"]);
    runRootTerminal(term);

    await vi.waitFor(() => expect(exactWrites(term, "!!")).toBe(1));
    expect(term.history).toEqual([]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "!!" },
    ]);

    env.window.fitAddon.fit = vi.fn(() => { term.cols = 40; });
    await term.resizeListener();
    expect(exactWrites(term, "!!")).toBe(2);
    expect(term.history).toEqual([]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "!!" },
    ]);

    for (const character of "echo a") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo a"]));
    for (const character of "!!") term._onData(character);
    term._onData("\r");
    await vi.waitFor(() => expect(term.history).toEqual(["echo a", "echo a"]));

    expect(exactWrites(term, "echo a")).toBe(1);
    expect(exactWrites(term, "a")).toBe(2);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "!!" },
      { event: "commandSent", command: "echo", args: "a" },
      { event: "commandSent", command: "echo", args: "a" },
    ]);

    term.deepLink = "echo plain";
    await term.runDeepLink();
    expect(term.writeln).toHaveBeenLastCalledWith("plain");
    expect(term.history).toEqual(["echo a", "echo a"]);
    expect(env.window.dataLayer.at(-1)).toEqual({
      event: "commandSent",
      command: "echo",
      args: "plain",
    });
  });
});

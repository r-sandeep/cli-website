import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

const keyEvent = (key, overrides = {}) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  type: "keydown",
  key,
  preventDefault: vi.fn(),
  ...overrides,
});

function createTerm() {
  const output = [];
  const term = {
    VERSION: 4,
    _core: { buffer: { x: 0 } },
    _initialized: false,
    attachCustomKeyEventHandler: vi.fn((handler) => {
      term.key = handler;
    }),
    buffer: {
      active: {
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: () => ({ isWrapped: false }),
      },
    },
    clear: vi.fn(),
    closePrompt: vi.fn(),
    cols: 120,
    focus: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn((handler) => {
      term.input = handler;
    }),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn((text) => output.push(String(text))),
    writeln: vi.fn((text = "") => output.push(`${String(text)}\r\n`)),
  };
  return { term, output };
}

function createRenderedTerm() {
  const output = [];
  const rows = [""];
  let cursorRow = 0;
  let cursorColumn = 0;
  let savedCursor = { row: 0, column: 0 };

  const ensureRow = () => {
    while (rows.length <= cursorRow) rows.push("");
  };
  const syncCursor = (term) => {
    term._core.buffer.x = cursorColumn;
    term.buffer.active.cursorX = cursorColumn;
    term.buffer.active.cursorY = cursorRow;
  };
  const render = (term, text) => {
    output.push(String(text));
    const value = String(text);
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === "\x1b") {
        const next = value[index + 1];
        if (next === "7") {
          savedCursor = { row: cursorRow, column: cursorColumn };
          index += 1;
          continue;
        }
        if (next === "8") {
          cursorRow = savedCursor.row;
          cursorColumn = savedCursor.column;
          ensureRow();
          index += 1;
          continue;
        }
        if (next === "[") {
          let end = index + 2;
          while (end < value.length && !/[A-Za-z]/.test(value[end])) end += 1;
          const command = value[end];
          const rawParameter = value.slice(index + 2, end);
          const amount = Number.parseInt(rawParameter, 10) || 1;
          if (command === "D") cursorColumn = Math.max(0, cursorColumn - amount);
          else if (command === "C") cursorColumn += amount;
          else if (command === "A") cursorRow = Math.max(0, cursorRow - amount);
          else if (command === "B") cursorRow += amount;
          else if (command === "J") {
            ensureRow();
            rows[cursorRow] = rows[cursorRow].slice(0, cursorColumn);
            rows.splice(cursorRow + 1);
          } else if (command === "K") {
            ensureRow();
            if (rawParameter === "2") rows[cursorRow] = "";
            else rows[cursorRow] = rows[cursorRow].slice(0, cursorColumn);
          }
          index = end;
          ensureRow();
          continue;
        }
      }
      if (character === "\r") {
        cursorColumn = 0;
      } else if (character === "\n") {
        cursorRow += 1;
        ensureRow();
      } else {
        ensureRow();
        const row = rows[cursorRow];
        rows[cursorRow] =
          row.slice(0, cursorColumn) + character + row.slice(cursorColumn + 1);
        cursorColumn += 1;
      }
    }
    syncCursor(term);
  };

  const term = {
    VERSION: 4,
    _core: { buffer: { x: 0 } },
    _initialized: false,
    attachCustomKeyEventHandler: vi.fn((handler) => {
      term.key = handler;
    }),
    buffer: {
      active: {
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
        getLine: () => ({ isWrapped: false }),
      },
    },
    clear: vi.fn(),
    closePrompt: vi.fn(),
    cols: 120,
    focus: vi.fn(),
    loadAddon: vi.fn(),
    onData: vi.fn((handler) => {
      term.input = handler;
    }),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn((text) => render(term, text)),
    writeln: vi.fn((text = "") => render(term, `${String(text)}\r\n`)),
  };
  return {
    term,
    output,
    rendered: () => ({ rows: [...rows], cursorRow, cursorColumn }),
  };
}

function loadProductionEnvironment() {
  const env = createBrowserEnv({
    globals: {
      COMMAND_ASSETS: {},
      SpawnRickRollPointers: vi.fn(),
      analyticsEvent: vi.fn(),
      buildInfo: { version: "test", buildDate: "test" },
      config: {},
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      fitAddon: { fit: vi.fn() },
      getArt: vi.fn(() => ""),
      getASCIIArtIdForCommand: vi.fn(() => null),
      getPreloadFileForCommand: vi.fn(() => null),
      openRootTui: vi.fn(),
      preloadASCIIArt: vi.fn(),
      scheduleIdleTask: vi.fn(),
    },
  });
  env.loadScripts([
    "js/ascii-art.js",
    "config/firm.js",
    "config/team.js",
    "config/portfolio.js",
    "config/jobs.js",
    "config/help.js",
    "config/fs.js",
    "js/bookmarks.js",
    "config/commands.js",
    "js/pipeline.js",
    "js/terminal-ext.js",
    "js/terminal.js",
  ]);
  return {
    env,
    ...env.exportValues(["extend", "runRootTerminal"]),
  };
}

function createRealXtermEnvironment({ cols = 120, rows = 12 } = {}) {
  const { env, extend, runRootTerminal } = loadProductionEnvironment();
  let term;
  try {
    term = new Terminal({ cols, rows, allowProposedApi: true });
  } catch (error) {
    throw new Error(`real xterm construction failed: ${error?.message || error}`);
  }
  const writes = [];
  const originalWrite = term.write.bind(term);
  const originalWriteln = term.writeln.bind(term);
  let pendingWrites = Promise.resolve();
  const queueWrite = (text, callback) => {
    writes.push(String(text));
    pendingWrites = pendingWrites.then(
      () => new Promise((resolve) => originalWrite(String(text), () => {
        if (typeof callback === "function") callback();
        resolve();
      }))
    );
  };
  term.write = (text, callback) => queueWrite(text, callback);
  term.writeln = (text = "", callback) => queueWrite(`${String(text)}\r\n`, callback);
  term.focus = vi.fn();
  term.scrollToBottom = vi.fn();
  term.clear = vi.fn();
  term.reset = vi.fn();
  term.loadAddon = vi.fn();
  term.init = vi.fn();
  term.runDeepLink = vi.fn(() => Promise.resolve());
  term.attachCustomKeyEventHandler = vi.fn((handler) => {
    term.key = handler;
  });
  Object.defineProperty(term, "onData", {
    configurable: true,
    value: vi.fn((handler) => {
      term.input = handler;
      return { dispose: vi.fn() };
    }),
  });

  env.window.term = term;
  env.window.dataLayer = [];
  extend(term);
  runRootTerminal(term);
  return {
    env,
    term,
    writes,
    flush: () => pendingWrites,
    originalWriteln,
  };
}

function createIntegrationEnvironment() {
  const { env, extend, runRootTerminal } = loadProductionEnvironment();
  const { term, output } = createTerm();
  env.window.term = term;
  env.window.dataLayer = [];
  extend(term);

  // Keep production command parsing, dispatch, pipeline capture, history and
  // analytics intact while replacing only the physical xterm initialization.
  term.init = vi.fn();
  term.prompt = vi.fn();
  term.runDeepLink = vi.fn(() => Promise.resolve());
  term.pos = () => term.currentLine.length;
  term.clearCurrentLine = vi.fn((toNewest = false) => {
    term.currentLine = "";
    if (toNewest) term.historyCursor = -1;
  });
  term.setCurrentLine = vi.fn((line) => {
    term.currentLine = line;
  });
  runRootTerminal(term);
  term.prompt.mockClear();
  term.clearCurrentLine.mockClear();
  return { env, term, output };
}

function createTranscriptEnvironment() {
  const { env, extend, runRootTerminal } = loadProductionEnvironment();
  const renderedTerm = createRenderedTerm();
  const { term } = renderedTerm;
  env.window.term = term;
  env.window.dataLayer = [];
  extend(term);

  // Retain production prompt, clearing, search cancellation, rendering, input
  // handlers, dispatch, history and analytics. Only physical startup is inert.
  term.init = vi.fn();
  term.runDeepLink = vi.fn(() => Promise.resolve());
  runRootTerminal(term);
  return { env, ...renderedTerm };
}

async function submit(term, line) {
  for (const character of line) term.input(character);
  expect(term.currentLine).toBe(line);
  term.input("\r");
  await vi.waitFor(() => expect(term.busy).toBe(false));
}

async function searchAndSubmit(term, query) {
  const event = keyEvent("r", { ctrlKey: true, code: "KeyR" });
  expect(term.key(event)).toBe(false);
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  for (const character of query) term.input(character);
  term.input("\r");
  await vi.waitFor(() => expect(term.busy).toBe(false));
}

let environments = [];
afterEach(() => {
  for (const environment of environments) environment.env.cleanup();
  environments = [];
});

describe("reverse search production integration", () => {
  it.each([
    ["standalone", "echo A", "A\r\n"],
    ["successful pipeline", "echo B | wc -l", "1\r\n"],
    ["invalid pipeline", "echo B | head 0", "head: count must be a positive base-10 integer"],
  ])("matches ordinary submission for a %s command", async (_name, line, expectedOutput) => {
    const ordinary = createIntegrationEnvironment();
    const searched = createIntegrationEnvironment();
    environments.push(ordinary, searched);

    await submit(ordinary.term, line);
    await submit(ordinary.term, line);
    await submit(ordinary.term, "pwd");

    await submit(searched.term, line);
    const historyBefore = [...searched.term.history];
    const analyticsBefore = [...searched.env.window.dataLayer];
    const outputStart = searched.output.length;
    await searchAndSubmit(searched.term, line);

    expect(searched.output.slice(outputStart).join("")).toContain(expectedOutput);
    expect(searched.term.history).toEqual([...historyBefore, line]);
    expect(searched.env.window.dataLayer).toEqual([
      ...analyticsBefore,
      {
        event: "commandSent",
        command: line.split(/\s+/)[0],
        args: line.slice(line.indexOf(" ") + 1),
      },
    ]);
    expect(searched.term.busy).toBe(false);

    await submit(searched.term, "pwd");
    expect(searched.output.join("")).toContain("/home/guest");
    expect(searched.term.history).toEqual(ordinary.term.history);
    expect(searched.env.window.dataLayer).toEqual(ordinary.env.window.dataLayer);
  });

  it("routes supplementary, BMP, and ASCII queries through production search and dispatch", async () => {
    const fixture = createIntegrationEnvironment();
    environments.push(fixture);
    const { term, env, output } = fixture;
    term.history = ["echo 😀 older", "echo plain", "echo 😀 newest"];

    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("😀");
    expect(term.getReverseSearchState()).toEqual({
      active: true,
      query: "😀",
      match: "echo 😀 newest",
      failed: false,
    });
    expect(output.join("")).toContain("(reverse-i-search)`😀': echo 😀 newest");
    expect(term.history).toEqual(["echo 😀 older", "echo plain", "echo 😀 newest"]);
    expect(env.window.dataLayer).toEqual([]);

    term.key(keyEvent("r", { ctrlKey: true }));
    expect(term.getReverseSearchState()).toMatchObject({
      query: "😀",
      match: "echo 😀 older",
      failed: false,
    });
    const historyBeforeSubmit = [...term.history];
    term.input("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    expect(output.join("")).toContain("😀 older");
    expect(term.history).toEqual([...historyBeforeSubmit, "echo 😀 older"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "😀 older" },
    ]);

    for (const [query, match] of [["界", "echo 界"], ["A", "echo A"]]) {
      term.history.push(match);
      term.key(keyEvent("r", { ctrlKey: true }));
      term.input(query);
      expect(term.getReverseSearchState()).toMatchObject({ query, match, failed: false });
      term.key(keyEvent("Escape"));
    }

    term.history = [];
    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("😀");
    expect(term.getReverseSearchState()).toEqual({
      active: true,
      query: "😀",
      match: "",
      failed: true,
    });
    expect(output.join("")).toContain("(failed reverse-i-search)`😀': ");
    const failedState = term.getReverseSearchState();
    const outputLength = output.length;
    for (const inertInput of ["\u0000", "\u0085", "\x1b[A", "\x1b[D"]) {
      term.input(inertInput);
      expect(term.getReverseSearchState()).toEqual(failedState);
    }
    expect(output).toHaveLength(outputLength);
  });

  it("recovers from a supplementary query through DEL and Ctrl+H before ordinary editing", async () => {
    const fixture = createIntegrationEnvironment();
    environments.push(fixture);
    const { term, env, output } = fixture;
    await submit(term, "echo A");
    await submit(term, "echo B");

    const historyBeforeSearch = [...term.history];
    const analyticsBeforeSearch = [...env.window.dataLayer];
    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("A");
    term.input("😀");
    expect(term.getReverseSearchState()).toEqual({
      active: true,
      query: "A😀",
      match: "echo A",
      failed: true,
    });

    term.input("\u007f");
    expect(term.getReverseSearchState()).toEqual({
      active: true,
      query: "A",
      match: "echo A",
      failed: false,
    });
    expect(output.join("")).toContain("(reverse-i-search)`A': echo A");
    expect(term.history).toEqual(historyBeforeSearch);
    expect(env.window.dataLayer).toEqual(analyticsBeforeSearch);

    term.key(keyEvent("ArrowRight"));
    expect(term.currentLine).toBe("echo A");
    expect(term.history).toEqual(historyBeforeSearch);
    expect(env.window.dataLayer).toEqual(analyticsBeforeSearch);
    term.input("\u007f");
    term.input("C");
    expect(term.currentLine).toBe("echo C");
    term.input("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    expect(output.join("")).toContain("C\r\n");
    expect(term.history).toEqual([...historyBeforeSearch, "echo C"]);
    expect(env.window.dataLayer).toEqual([
      ...analyticsBeforeSearch,
      { event: "commandSent", command: "echo", args: "C" },
    ]);

    const historyAfterExecution = [...term.history];
    const analyticsAfterExecution = [...env.window.dataLayer];
    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("C");
    term.input("😀");
    term.input("\u0008");
    expect(term.getReverseSearchState()).toEqual({
      active: true,
      query: "C",
      match: "echo C",
      failed: false,
    });
    expect(term.history).toEqual(historyAfterExecution);
    expect(env.window.dataLayer).toEqual(analyticsAfterExecution);
  });

  it("keeps failed retained matches executable and all non-executing exits inert", async () => {
    const fixture = createIntegrationEnvironment();
    environments.push(fixture);
    const { term, env } = fixture;
    await submit(term, "echo A");
    await submit(term, "echo B");

    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("A");
    term.input("Z");
    expect(term.getReverseSearchState()).toMatchObject({ match: "echo A", failed: true });
    const beforeFailedEnter = {
      history: [...term.history],
      analytics: [...env.window.dataLayer],
    };
    term.input("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    expect(term.history).toEqual([...beforeFailedEnter.history, "echo A"]);
    expect(env.window.dataLayer).toHaveLength(beforeFailedEnter.analytics.length + 1);

    const beforeCancel = { history: [...term.history], analytics: [...env.window.dataLayer] };
    for (const cancel of [keyEvent("Escape"), keyEvent("g", { ctrlKey: true })]) {
      term.currentLine = "echo draft";
      term.key(keyEvent("r", { ctrlKey: true }));
      term.input("B");
      term.key(cancel);
      expect(term.currentLine).toBe("echo draft");
      expect(term.history).toEqual(beforeCancel.history);
      expect(env.window.dataLayer).toEqual(beforeCancel.analytics);
    }

    term.currentLine = "";
    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("B");
    term.key(keyEvent("ArrowRight"));
    expect(term.currentLine).toBe("echo B");
    expect(term.history).toEqual(beforeCancel.history);
    expect(env.window.dataLayer).toEqual(beforeCancel.analytics);

    term.currentLine = "";
    term.history = [];
    term.key(keyEvent("r", { ctrlKey: true }));
    term.input("missing");
    term.input("\r");
    expect(term.currentLine).toBe("");
    expect(term.history).toEqual([]);
    expect(env.window.dataLayer).toEqual(beforeCancel.analytics);
  });

  it("restores real xterm cell coordinates and resumes wide draft editing", async () => {
    let fixture;
    try {
      fixture = createRealXtermEnvironment();
    } catch (error) {
      throw new Error(`real xterm fixture setup failed: ${error?.message || error}`);
    }
    environments.push(fixture);
    const { term, env, flush } = fixture;
    await flush();

    for (const character of "echo 界a") {
      term.input(character);
      await flush();
    }
    term.input("\x1b[D");
    await flush();
    const saved = {
      x: term.buffer.active.cursorX,
      y: term.buffer.active.cursorY,
      history: [...term.history],
      analytics: [...env.window.dataLayer],
    };
    expect(term.buffer.active.getLine(term.buffer.active.baseY + saved.y).getCell(saved.x).getChars())
      .toBe("a");

    term.key(keyEvent("r", { ctrlKey: true }));
    await flush();
    term.key(keyEvent("Escape"));
    await flush();
    expect(term.buffer.active.cursorX).toBe(saved.x);
    expect(term.buffer.active.cursorY).toBe(saved.y);
    expect(term.getCanceledDraftCursor()).toBe("echo 界".length);
    expect(term.history).toEqual(saved.history);
    expect(env.window.dataLayer).toEqual(saved.analytics);

    term.input("X");
    await flush();
    expect(term.currentLine).toBe("echo 界Xa");
    expect(term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)
      .getCell(term.buffer.active.cursorX).getChars()).toBe("a");

    term.key(keyEvent("r", { ctrlKey: true }));
    await flush();
    term.input("\u0007");
    await flush();
    term.input("Y");
    await flush();
    expect(term.currentLine).toBe("echo 界XYa");
    expect(term.history).toEqual(saved.history);
    expect(env.window.dataLayer).toEqual(saved.analytics);

    term.input("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    await flush();
    expect(term.history).toEqual(["echo 界XYa"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "界XYa" },
    ]);
    expect(term.isCanceledDraftActive()).toBe(false);

    for (const character of "pwd") {
      term.input(character);
      await flush();
    }
    expect(term.currentLine).toBe("pwd");
    term.input("\r");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    await flush();
    expect(term.history).toEqual(["echo 界XYa", "pwd"]);
    expect(env.window.dataLayer).toEqual([
      { event: "commandSent", command: "echo", args: "界XYa" },
      { event: "commandSent", command: "pwd", args: "" },
    ]);
    const bufferText = Array.from(
      { length: term.buffer.active.length },
      (_, row) => term.buffer.active.getLine(row).translateToString(true)
    ).join("\n");
    expect(bufferText).toContain("界XYa");
    expect(bufferText).toContain("/home/guest");
  });

  it("restores real xterm ASCII, combining, wrapped, and margin cursors", async () => {
    for (const fixtureCase of [
      { cols: 120, line: "echo abcd", left: 1 },
      { cols: 120, line: "echo e\u0301a", left: 1 },
      { cols: 20, line: "echo 12345678901234567890", left: 4 },
      { cols: 20, line: "abc", left: 0 },
    ]) {
      const fixture = createRealXtermEnvironment({ cols: fixtureCase.cols });
      environments.push(fixture);
      const { term, env, flush } = fixture;
      await flush();
      for (const character of fixtureCase.line) {
        term.input(character);
        await flush();
      }
      for (let count = 0; count < fixtureCase.left; count += 1) {
        term.input("\x1b[D");
        await flush();
      }
      const saved = {
        x: term.buffer.active.cursorX,
        y: term.buffer.active.cursorY,
        line: term.currentLine,
        history: [...term.history],
        analytics: [...env.window.dataLayer],
      };

      term.key(keyEvent("r", { ctrlKey: true }));
      await flush();
      term.input("missing");
      await flush();
      term.input("\u001b");
      await flush();
      expect(term.currentLine).toBe(saved.line);
      expect(term.buffer.active.cursorX, JSON.stringify(fixtureCase)).toBe(saved.x);
      expect(term.buffer.active.cursorY, JSON.stringify(fixtureCase)).toBe(saved.y);
      expect(term.history).toEqual(saved.history);
      expect(env.window.dataLayer).toEqual(saved.analytics);
    }
  });

  it.each([
    ["successful", "A", { match: "echo A", failed: false }],
    ["failed retained", "AZ", { match: "echo A", failed: true }],
    ["never matched", "Z", { match: "", failed: true }],
  ])(
    "matches the complete ordinary Ctrl+C transcript for a %s search",
    async (_name, query, expectedSearch) => {
      const ordinary = createTranscriptEnvironment();
      const searched = createTranscriptEnvironment();
      environments.push(ordinary, searched);

      for (const fixture of [ordinary, searched]) {
        fixture.term.history = ["echo A", "echo B"];
        fixture.term.historyCursor = 1;
        fixture.term.tabIndex = 2;
        fixture.term.tabOptions = ["echo"];
        fixture.term.tabBase = "ec";
        for (const character of "echo draft") fixture.term.input(character);
        fixture.term.input("\x1b[D");
        fixture.term.input("\x1b[D");
        fixture.term.input("\x1b[D");
      }

      const historyBefore = ["echo A", "echo B"];
      const ordinaryInterruptStart = ordinary.output.length;
      ordinary.term.input("\u0003");
      const ordinaryInterruptWrites = ordinary.output.slice(ordinaryInterruptStart);

      searched.term.key(keyEvent("r", { ctrlKey: true }));
      for (const character of query) searched.term.input(character);
      expect(searched.term.getReverseSearchState()).toMatchObject(expectedSearch);
      const searchedInterruptStart = searched.output.length;
      searched.term.input("\u0003");
      const searchedInterruptWrites = searched.output.slice(searchedInterruptStart);

      expect(searchedInterruptWrites[0]).toContain("echo draft");
      expect(searchedInterruptWrites.slice(-ordinaryInterruptWrites.length)).toEqual(
        ordinaryInterruptWrites
      );
      expect(searched.rendered()).toEqual(ordinary.rendered());
      for (const fixture of [ordinary, searched]) {
        expect(fixture.term.currentLine).toBe("");
        expect(fixture.term.isReverseSearchActive()).toBe(false);
        expect(fixture.term.historyCursor).toBe(-1);
        expect(fixture.term.history).toEqual(historyBefore);
        expect(fixture.env.window.dataLayer).toEqual([]);
        expect(fixture.term.tabIndex).toBe(0);
        expect(fixture.term.tabOptions).toEqual([]);
        expect(fixture.term.tabBase).toBe("");
      }

      await submit(ordinary.term, "pwd");
      await submit(searched.term, "pwd");
      expect(searched.rendered()).toEqual(ordinary.rendered());
      for (const fixture of [ordinary, searched]) {
        expect(fixture.rendered().rows).toContain("/home/guest");
        expect(fixture.term.history).toEqual([...historyBefore, "pwd"]);
        expect(fixture.env.window.dataLayer).toEqual([
          { event: "commandSent", command: "pwd", args: "" },
        ]);
      }
    }
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

const flushWrites = (term) =>
  new Promise((resolve) => term.write("", resolve));

const bufferText = (term) => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index++) {
    const line = buffer.getLine(index);
    if (line && !line.isWrapped) lines.push(line.translateToString(true));
    else if (line && lines.length) lines[lines.length - 1] += line.translateToString(true);
  }
  return lines.filter(Boolean);
};

function loadProductionTerminal({ columns = 28, hash = "", savedHistory = [] } = {}) {
  const raf = [];
  const fitWidths = [];
  env = createBrowserEnv({
    html: '<!doctype html><html><body><div id="terminal"></div></body></html>',
    url: `https://www.root.vc/${hash}`,
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      colorText: (text) => text,
      commands: {},
      dataLayer: [],
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      jobs: {},
      portfolio: {},
      requestAnimationFrame: vi.fn((callback) => {
        raf.push(callback);
        return raf.length;
      }),
      scheduleIdleTask: vi.fn((task) => task()),
      team: {},
    },
  });
  const term = new Terminal({ allowProposedApi: true, cols: columns, rows: 24 });
  env.window.localStorage.setItem("rootvc.history", JSON.stringify(savedHistory));
  const attachCustomKeyEventHandler = term.attachCustomKeyEventHandler.bind(term);
  term.attachCustomKeyEventHandler = (handler) => {
    term._customKeyHandler = handler;
    return attachCustomKeyEventHandler(handler);
  };
  env.window.fitAddon = {
    fit: vi.fn(() => {
      const next = fitWidths.shift();
      if (next) term.resize(next, 24);
    }),
  };
  env.loadScripts([
    "js/history.js",
    "js/pipeline.js",
    "js/terminal-ext.js",
    "js/terminal.js",
  ]);
  const { extend } = env.exportValues(["extend"]);
  extend(term);
  term.VERSION = 4;
  term.printLogoType = vi.fn();
  term.stylePrint = (text) => term.writeln(String(text));
  term.focus = vi.fn();
  const dispatches = [];
  env.window.commands.echo = (args) => {
    dispatches.push(["echo", [...args]]);
    term.writeln(args.join(" "));
  };
  env.window.commands.set = (args) => {
    dispatches.push(["set", [...args]]);
    term.environment.set(args[0], args.slice(1).join(" "));
  };
  env.window.commands.ping = () => {
    dispatches.push(["ping", []]);
    term.writeln("pong");
  };
  env.window.runRootTerminal(term);
  return { dispatches, fitWidths, raf, term };
}

function loadProductionApplicationTerminal({ columns = 32 } = {}) {
  env = createBrowserEnv({
    html: '<!doctype html><html><body><div id="terminal"></div></body></html>',
    globals: {
      LOGO_TYPE: "ROOT",
      _DIRS: { "~": [] },
      buildInfo: { version: "test", buildDate: "2026-10-18" },
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      firm: { email: "hello@example.com" },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      help: {},
      portfolio: {},
      scheduleIdleTask: vi.fn((task) => task()),
      shortcuts: {},
      team: {},
    },
  });
  const term = new Terminal({ allowProposedApi: true, cols: columns, rows: 40 });
  const attachCustomKeyEventHandler = term.attachCustomKeyEventHandler.bind(term);
  term.attachCustomKeyEventHandler = (handler) => {
    term._customKeyHandler = handler;
    return attachCustomKeyEventHandler(handler);
  };
  env.window.term = term;
  env.window.fitAddon = { fit: vi.fn() };
  env.loadScripts([
    "js/terminal.js",
    "js/pipeline.js",
    "js/history.js",
    "js/terminal-ext.js",
    "config/commands.js",
    "config/jobs.js",
  ]);
  const { extend, runRootTerminal } = env.exportValues(["extend", "runRootTerminal"]);
  extend(term);
  term.VERSION = 4;
  term.printLogoType = vi.fn();
  term.focus = vi.fn();
  runRootTerminal(term);
  return { term };
}

const submitThroughKeyboard = (term, line) => {
  for (const character of line) term.input(character, true);
  term.input("\r", true);
};

async function runResize(env, fixture, width) {
  fixture.fitWidths.push(width);
  env.window.dispatchEvent(new env.window.Event("resize"));
  fixture.raf.shift()();
  await vi.waitFor(() => expect(env.window.fitAddon.fit).toHaveBeenCalled());
  await flushWrites(fixture.term);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  env?.cleanup();
  env = undefined;
});

describe("history lifecycle with installed xterm", () => {
  it("retains repeated wrapped apply cancellations and resumes normal pipeline input", async () => {
    const { term } = loadProductionApplicationTerminal({ columns: 32 });
    await flushWrites(term);
    const originalMethods = {
      write: term.write,
      writeln: term.writeln,
      collectInput: term.collectInput,
      prompt: term.prompt,
      clearCurrentLine: term.clearCurrentLine,
    };
    const rawApply = `apply 1${" ".repeat(50)}| head 99`;

    const cancelApplication = async () => {
      submitThroughKeyboard(term, rawApply);
      await vi.waitFor(() => expect(term.locked).toBe(true));
      await flushWrites(term);
      expect(bufferText(term).join("\n")).toContain("What's your name?:");

      // Collection owns input: Ctrl+R must not start normal history search.
      term.input("\u0012", true);
      expect(term.historySearch).toBeNull();
      expect(term.locked).toBe(true);
      term.input("\u0003", true);
      await vi.waitFor(() => expect(term.locked).toBe(false));
      await vi.waitFor(() => expect(term.busy).toBe(false));
      await flushWrites(term);
    };

    await cancelApplication();
    let output = bufferText(term);
    expect(output.filter((line) => line === "Application cancelled.")).toHaveLength(1);
    const introductionIndex = output.findIndex((line) =>
      line.startsWith("Great! Let's get your")
    );
    const cancellationIndex = output.indexOf("Application cancelled.");
    expect(introductionIndex).toBeGreaterThan(-1);
    expect(cancellationIndex).toBeGreaterThan(introductionIndex);
    expect(term.currentLine).toBe("");
    expect(term.pos()).toBe(0);
    expect(term.history).toEqual([rawApply]);
    expect(env.window.dataLayer).toHaveLength(1);
    expect(term.write).toBe(originalMethods.write);
    expect(term.writeln).toBe(originalMethods.writeln);
    expect(term.collectInput).toBe(originalMethods.collectInput);
    expect(term.prompt).toBe(originalMethods.prompt);
    expect(term.clearCurrentLine).toBe(originalMethods.clearCurrentLine);

    await cancelApplication();
    output = bufferText(term);
    expect(output.filter((line) => line === "Application cancelled.")).toHaveLength(2);
    expect(term.history).toEqual([rawApply, rawApply]);
    expect(env.window.dataLayer).toHaveLength(2);

    submitThroughKeyboard(term, "echo resumed");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    await flushWrites(term);
    output = bufferText(term);
    expect(output.filter((line) => line === "resumed")).toHaveLength(1);
    expect(output.filter((line) => line === "Application cancelled.")).toHaveLength(2);

    submitThroughKeyboard(term, "echo NEXT | head 99");
    await vi.waitFor(() => expect(term.busy).toBe(false));
    await flushWrites(term);
    output = bufferText(term);
    expect(output.filter((line) => line === "NEXT")).toHaveLength(1);
    expect(output.filter((line) => line === "resumed")).toHaveLength(1);
    expect(output.filter((line) => line === "Application cancelled.")).toHaveLength(2);
    expect(term.history).toEqual([
      rawApply,
      rawApply,
      "echo resumed",
      "echo NEXT | head 99",
    ]);
    expect(env.window.dataLayer).toHaveLength(4);
    expect(term.currentLine).toBe("");
    expect(term.pos()).toBe(0);
    expect(term.locked).toBe(false);
    expect(term.busy).toBe(false);
    expect(term.write).toBe(originalMethods.write);
    expect(term.writeln).toBe(originalMethods.writeln);
    expect(term.collectInput).toBe(originalMethods.collectInput);
    expect(term.prompt).toBe(originalMethods.prompt);
    expect(term.clearCurrentLine).toBe(originalMethods.clearCurrentLine);
  });

  it("renders persisted terminal controls inert during recall and reverse search", async () => {
    const raw =
      "echo SAFE\u001b[2JFAKE\u001b]0;FORGED\u0007LINK\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007\u009b31m\u007f";
    const fixture = loadProductionTerminal({
      columns: 48,
      savedHistory: [raw, raw],
    });
    const { dispatches, term } = fixture;
    const titles = [];
    term.onTitleChange((title) => titles.push(title));
    term.writeln("CONTROL-ANCHOR");
    term.prompt();
    await flushWrites(term);
    const storedBefore = env.window.localStorage.getItem("rootvc.history");
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];

    term.input("\u001b[A", true);
    await flushWrites(term);
    expect(term.currentLine).toBe(raw);
    expect(term.pos()).toBe(raw.length);
    expect(bufferText(term).join("\n")).toContain("CONTROL-ANCHOR");
    expect(bufferText(term).join("\n")).toContain(
      "\\x1b[2JFAKE\\x1b]0;FORGED\\x07LINK"
    );
    expect(titles).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.localStorage.getItem("rootvc.history")).toBe(storedBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.input("\u0003", true);
    expect(
      term._customKeyHandler({
        altKey: false,
        ctrlKey: true,
        key: "r",
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
        type: "keydown",
      })
    ).toBe(false);
    for (const character of "SAFE") term.input(character, true);
    await flushWrites(term);
    expect(term.historySearch).toMatchObject({ query: "SAFE", selectedHistoryIndex: 1 });
    expect(bufferText(term).join("\n")).toContain(
      "search [SAFE]: echo SAFE\\x1b[2JFAKE"
    );
    expect(bufferText(term).join("\n")).toContain("CONTROL-ANCHOR");
    expect(titles).toEqual([]);
    expect(dispatches).toEqual([]);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.localStorage.getItem("rootvc.history")).toBe(storedBefore);

    term.input("\r", true);
    await flushWrites(term);
    expect(term.historySearch).toBeNull();
    expect(term.currentLine).toBe(raw);
    expect(term.pos()).toBe(raw.length);
    expect(dispatches).toEqual([]);
    expect(term.history).toEqual(historyBefore);

    term.input("\u0003", true);
    for (const character of "ping") term.input(character, true);
    term.input("\r", true);
    await vi.waitFor(() => expect(dispatches).toEqual([["ping", []]]));
    await flushWrites(term);
    expect(bufferText(term).filter((line) => line === "pong")).toHaveLength(1);
    expect(titles).toEqual([]);
  });

  it("keeps raw control-containing cursor offsets exact through editing, cancellation and resize", async () => {
    const raw = `echo 1234567890\u001b[2Jabcdefghij`;
    const fixture = loadProductionTerminal({ columns: 18, savedHistory: [raw] });
    const { dispatches, term } = fixture;
    await flushWrites(term);
    term.writeln("WIDTH-ANCHOR");
    term.prompt();
    term.input("\u001b[A", true);
    await flushWrites(term);

    for (let index = raw.length; index > 10; index--) term.input("\u001b[D", true);
    term.input("X", true);
    const edited = `${raw.slice(0, 10)}X${raw.slice(10)}`;
    expect(term.currentLine).toBe(edited);
    expect(term.pos()).toBe(11);

    expect(
      term._customKeyHandler({
        altKey: false,
        ctrlKey: true,
        key: "r",
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
        type: "keydown",
      })
    ).toBe(false);
    for (const character of "123") term.input(character, true);
    term.input("\u001b", true);
    expect(term.currentLine).toBe(edited);
    expect(term.pos()).toBe(11);

    await runResize(env, fixture, 52);
    await runResize(env, fixture, 16);
    expect(term.currentLine).toBe(edited);
    expect(term.pos()).toBe(11);
    expect(bufferText(term).join("\n")).toContain("WIDTH-ANCHOR");
    expect(dispatches).toEqual([]);
    expect(term.history).toEqual([raw]);

    term.input("\u0003", true);
    for (const character of "ping") term.input(character, true);
    term.input("\r", true);
    await vi.waitFor(() => expect(dispatches).toEqual([["ping", []]]));
    await flushWrites(term);
    expect(bufferText(term).filter((line) => line === "pong")).toHaveLength(1);
  });

  it("preserves output, wrapped editable input and logical cursor across real resize events", async () => {
    const fixture = loadProductionTerminal({ columns: 28 });
    const { dispatches, term } = fixture;
    await flushWrites(term);
    await term.executeCommandLine("echo DISTINCT-OUTPUT");
    await term.executeCommandLine("set COLOR blue");
    await flushWrites(term);

    const draft = "echo this draft crosses rows exactly once";
    term.renderInput(draft, 12);
    await flushWrites(term);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    const outputBefore = bufferText(term).join("\n");
    expect(outputBefore).toContain("DISTINCT-OUTPUT");

    await runResize(env, fixture, 52);
    await runResize(env, fixture, 22);

    expect(term.currentLine).toBe(draft);
    expect(term.pos()).toBe(12);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);
    expect(dispatches).toEqual([
      ["echo", ["DISTINCT-OUTPUT"]],
      ["set", ["COLOR", "blue"]],
    ]);
    expect(bufferText(term).join("\n")).toContain("DISTINCT-OUTPUT");

    term.input("X", true);
    await flushWrites(term);
    expect(term.currentLine).toBe("echo this drXaft crosses rows exactly once");
    expect(term.pos()).toBe(13);
    term.input("\r", true);
    await vi.waitFor(() => expect(dispatches).toHaveLength(3));
    await flushWrites(term);
    expect(dispatches[2]).toEqual([
      "echo",
      ["this", "drXaft", "crosses", "rows", "exactly", "once"],
    ]);
    expect(bufferText(term).join("\n")).toContain(
      "this drXaft crosses rows exactly once"
    );
  });

  it("preserves an active reverse search and its exact cancellation snapshot across resize", async () => {
    const fixture = loadProductionTerminal({ columns: 24 });
    const { dispatches, term } = fixture;
    await flushWrites(term);
    await term.executeCommandLine("echo RETAINED-OUTPUT");
    await term.executeCommandLine("echo older-search-match");
    await flushWrites(term);

    const draft = "echo draft spans more than one terminal row";
    const draftCursor = 12;
    term.renderInput(draft, draftCursor);
    await flushWrites(term);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];
    const dispatchCount = dispatches.length;

    expect(
      term._customKeyHandler({
        altKey: false,
        ctrlKey: true,
        key: "r",
        metaKey: false,
        preventDefault: vi.fn(),
        shiftKey: false,
        type: "keydown",
      })
    ).toBe(false);
    for (const character of "older") term.input(character, true);
    await flushWrites(term);
    expect(term.historySearch).toMatchObject({
      savedDraft: draft,
      savedCursor: draftCursor,
      query: "older",
      selectedHistoryIndex: 1,
    });
    expect(bufferText(term).join("\n")).toContain(
      "search [older]: echo older-search-match"
    );
    expect(dispatches).toHaveLength(dispatchCount);
    expect(term.history).toEqual(historyBefore);

    await runResize(env, fixture, 48);
    await runResize(env, fixture, 20);
    expect(term.historySearch).toMatchObject({
      savedDraft: draft,
      savedCursor: draftCursor,
      query: "older",
      selectedHistoryIndex: 1,
    });
    expect(bufferText(term).join("\n")).toContain("RETAINED-OUTPUT");
    expect(bufferText(term).join("\n")).toContain(
      "search [older]: echo older-search-match"
    );
    expect(dispatches).toHaveLength(dispatchCount);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.input("\u0007", true);
    await flushWrites(term);
    expect(term.historySearch).toBeNull();
    expect(term.currentLine).toBe(draft);
    expect(term.pos()).toBe(draftCursor);
    expect(bufferText(term).join("\n")).toContain("RETAINED-OUTPUT");
    expect(bufferText(term).join("\n")).not.toContain("search [older]");
    expect(dispatches).toHaveLength(dispatchCount);

    term.input("X", true);
    expect(term.currentLine).toBe("echo draft sXpans more than one terminal row");
    term.input("\u0003", true);
    for (const character of "ping") term.input(character, true);
    term.input("\r", true);
    await vi.waitFor(() => expect(dispatches).toHaveLength(dispatchCount + 1));
    await flushWrites(term);
    expect(dispatches.at(-1)).toEqual(["ping", []]);
    expect(bufferText(term).join("\n")).toContain("pong");
  });

  it("fits without replay while busy and while the retained TUI owns input", async () => {
    const fixture = loadProductionTerminal({ columns: 32, hash: "#echo-DEEP" });
    const { dispatches, term } = fixture;
    await vi.waitFor(() => expect(dispatches).toHaveLength(1));
    await flushWrites(term);
    const deepLinkCount = dispatches.length;

    env.window.commands.ask = async () => {
      dispatches.push(["ask", []]);
      const answer = await term.collectInput("Question");
      term.writeln(`answer:${answer}`);
    };
    const continuation = term.executeCommandLine("ask", {
      showLeadingNewline: false,
    });
    await vi.waitFor(() => expect(term.locked).toBe(true));
    const historyDuringContinuation = [...term.history];
    term.input("\u0012", true);
    for (const character of "answer") term.input(character, true);
    await runResize(env, fixture, 48);
    expect(dispatches).toEqual([["echo", ["DEEP"]], ["ask", []]]);
    expect(term.history).toEqual(historyDuringContinuation);
    expect(term.busy).toBe(true);
    expect(term.locked).toBe(true);
    term.input("\r", true);
    await continuation;
    await flushWrites(term);
    expect(term.busy).toBe(false);
    expect(term.locked).toBe(false);
    expect(bufferText(term).join("\n")).toContain("answer:answer");

    const historyBefore = [...term.history];
    env.window.term = term;
    env.loadScript("js/tui-launcher.js");
    env.window.openRootTui();
    const frame = env.document.querySelector("iframe.tui-session");
    expect(frame).not.toBeNull();
    expect(env.window.rootTui.active).toBe(true);
    await runResize(env, fixture, 24);
    expect(dispatches).toHaveLength(deepLinkCount + 1);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.rootTui.active).toBe(true);

    env.window.dispatchEvent(
      new env.window.MessageEvent("message", {
        data: { type: "root-tui-exit" },
        origin: env.window.location.origin,
        source: frame.contentWindow,
      })
    );
    expect(env.document.querySelector("iframe.tui-session")).toBeNull();
    expect(env.window.rootTui.active).toBe(false);
    expect(term.history).toEqual(historyBefore);
    expect(bufferText(term).join("\n")).toContain("DEEP");
    for (const character of "ping") term.input(character, true);
    term.input("\r", true);
    await vi.waitFor(() => expect(dispatches).toHaveLength(deepLinkCount + 2));
    await flushWrites(term);
    expect(dispatches.at(-1)).toEqual(["ping", []]);
    expect(bufferText(term).join("\n")).toContain("pong");
  });

  it("ordinary clear retains history and never reruns a deep link or recalled command", async () => {
    const fixture = loadProductionTerminal({ columns: 30, hash: "#echo-DEEP" });
    const { dispatches, term } = fixture;
    await vi.waitFor(() => expect(dispatches).toHaveLength(1));
    await term.executeCommandLine("echo FIRST");
    await term.executeCommandLine("echo SECOND");
    await flushWrites(term);
    const historyBefore = [...term.history];
    const analyticsBefore = [...env.window.dataLayer];

    term.clearScreen();
    await flushWrites(term);
    expect(term.history).toEqual(historyBefore);
    expect(dispatches).toHaveLength(3);
    expect(bufferText(term).join("\n")).not.toContain("FIRST");
    expect(bufferText(term).join("\n")).not.toContain("SECOND");

    term.input("\u001b[A", true);
    await flushWrites(term);
    expect(term.currentLine).toBe("echo SECOND");
    expect(dispatches).toHaveLength(3);
    await runResize(env, fixture, 44);
    expect(term.currentLine).toBe("echo SECOND");
    expect(dispatches).toHaveLength(3);
    expect(term.history).toEqual(historyBefore);
    expect(env.window.dataLayer).toEqual(analyticsBefore);

    term.input("\u0003", true);
    for (const character of "echo AFTER") term.input(character, true);
    term.input("\r", true);
    await vi.waitFor(() => expect(dispatches).toHaveLength(4));
    await flushWrites(term);
    expect(dispatches.at(-1)).toEqual(["echo", ["AFTER"]]);
    expect(bufferText(term).join("\n")).toContain("AFTER");
    expect(dispatches.filter(([, args]) => args[0] === "DEEP")).toHaveLength(1);
  });
});
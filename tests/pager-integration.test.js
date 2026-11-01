import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const PROMPT = "guest:rootpc ~ $";
const environments = [];
const terminals = [];

function flush(term) {
  return new Promise((resolve) => term.write("", resolve));
}

function bufferRows(buffer, trimRight = true) {
  const rows = [];
  for (let y = 0; y < buffer.length; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(trimRight) ?? "");
  }
  return rows;
}

function viewportRows(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y += 1) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return rows;
}

function visibleBuffer(term, buffer = term.buffer.normal) {
  return bufferRows(buffer).join("\n");
}

function eventFor(key, overrides = {}) {
  return {
    altKey: false,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: false,
    key,
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    type: "keydown",
    ...overrides,
  };
}

async function createProductionTerminal({
  cols = 80,
  rows = 12,
  url = "https://www.root.vc/",
  run = false,
  fetchResponse,
} = {}) {
  const fitAddon = { fit: vi.fn() };
  const env = createBrowserEnv({
    url,
    html: "<!doctype html><html><body><div id='files-all'></div></body></html>",
    globals: {
      LOGO_TYPE: "ROOT",
      Terminal,
      buildInfo: Object.freeze({ version: "9.8.7-test", buildDate: "2035-06-07" }),
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      fitAddon,
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
    },
  });
  environments.push(env);
  env.window.fetch = vi.fn().mockResolvedValue(fetchResponse || {
    ok: true,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(""),
  });
  env.loadScripts([
    "js/terminal.js",
    "js/pipeline.js",
    "js/pager.js",
    "js/terminal-ext.js",
    "config/help.js",
    "config/firm.js",
    "config/portfolio.js",
    "config/team.js",
    "config/jobs.js",
  ]);

  const term = new Terminal({ cols, rows, scrollback: 1000 });
  terminals.push(term);
  env.window.term = term;
  env.loadScripts(["config/commands.js", "config/fs.js"]);
  const exports = env.exportValues([
    "commands",
    "extend",
    "runRootTerminal",
    "_insertFileToDOM",
  ]);
  exports.extend(term);
  term.VERSION = 4;

  let keyHandler;
  const originalAttach = term.attachCustomKeyEventHandler.bind(term);
  term.attachCustomKeyEventHandler = (handler) => {
    keyHandler = handler;
    return originalAttach(handler);
  };
  let lastExecution = Promise.resolve();
  const executeCommandLine = term.executeCommandLine.bind(term);
  term.executeCommandLine = (...args) => {
    lastExecution = Promise.resolve(executeCommandLine(...args));
    return lastExecution;
  };

  if (run) {
    exports.runRootTerminal(term);
    await flush(term);
    term.currentLine = "";
    term._inputCursor = 0;
    term._inputCursorLine = "";
  }

  return {
    ...exports,
    env,
    fitAddon,
    key: (key, overrides) => keyHandler(eventFor(key, overrides)),
    lastExecution: () => lastExecution,
    send: (data) => term.input(data, true),
    term,
  };
}

async function submit(fixture, line) {
  for (const character of line) fixture.send(character);
  fixture.send("\r");
  await vi.waitFor(() => expect(fixture.term.history.at(-1)).toBe(line));
}

async function waitForPager(term) {
  await vi.waitFor(() => expect(term._pagerSession).toBeTruthy());
  await term._pagerSession.renderQueue;
  await flush(term);
}

async function closePager(fixture, key) {
  if (key === "Ctrl+C") fixture.send("\x03");
  else if (key === "q" || key === "Q") fixture.send(key);
  else fixture.key(key);
  await fixture.lastExecution();
  await flush(fixture.term);
  expect(fixture.term._pagerSession).toBeNull();
}

function numberedContent(count, { styled = true, interiorBlank = false } = {}) {
  const lines = Array.from({ length: count }, (_, index) => {
    if (interiorBlank && index === 4) return "";
    const label = `row-${String(index + 1).padStart(2, "0")}`;
    return styled && index === 0 ? `\x1b[31m${label}\x1b[0m` : label;
  });
  return `${lines.join("\r\n")}\r\n`;
}

async function executeWithoutPrompt(fixture, line) {
  await fixture.term.executeCommandLine(line, {
    addToHistory: false,
    promptAfter: false,
    scrollAfter: false,
    showLeadingNewline: false,
    trackAnalytics: false,
  });
  await flush(fixture.term);
}

afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
  for (const env of environments.splice(0)) env.cleanup();
  vi.restoreAllMocks();
});

describe("pager production composition", () => {
  it.each(["less", "more"])(
    "keeps the exact file fit boundary and original styling for %s",
    async (spelling) => {
      const cat = await createProductionTerminal();
      const pager = await createProductionTerminal();
      const content = numberedContent(11, { interiorBlank: true });
      cat._insertFileToDOM("welcome.htm", content);
      pager._insertFileToDOM("welcome.htm", content);

      await executeWithoutPrompt(cat, "cat welcome.htm");
      await executeWithoutPrompt(pager, `${spelling} welcome.htm`);

      expect(pager.term._pagerSession).toBeFalsy();
      expect(bufferRows(pager.term.buffer.normal, false)).toEqual(
        bufferRows(cat.term.buffer.normal, false)
      );
      const catCell = cat.term.buffer.normal.getLine(0).getCell(0);
      const pagerCell = pager.term.buffer.normal.getLine(0).getCell(0);
      expect(pagerCell.getFgColor()).toBe(catCell.getFgColor());
      expect(pagerCell.getFgColor()).not.toBe(0);

      const overflowing = await createProductionTerminal({ run: true });
      overflowing._insertFileToDOM(
        "welcome.htm",
        numberedContent(12, { interiorBlank: true })
      );
      await submit(overflowing, `${spelling} welcome.htm`);
      await waitForPager(overflowing.term);

      const frame = viewportRows(overflowing.term);
      expect(frame).toHaveLength(12);
      expect(frame.at(-1)).toBe("lines 1-11 of 12");
      expect(frame[0]).toBe("row-01");
      expect(frame[4]).toBe("");
      expect(overflowing.term.buffer.active).toBe(overflowing.term.buffer.alternate);
      await closePager(overflowing, "q");
    }
  );

  it.each([
    ["less", "q"],
    ["less", "Q"],
    ["less", "Ctrl+C"],
    ["more", "q"],
    ["more", "Q"],
    ["more", "Ctrl+C"],
  ])("restores the complete normal session for %s closed by %s", async (spelling, closeKey) => {
    const fixture = await createProductionTerminal({ rows: 6, run: true });
    fixture._insertFileToDOM("welcome.htm", numberedContent(8));
    fixture.term.writeln("distinctive normal transcript");
    fixture.term.prompt();
    await flush(fixture.term);

    const line = `${spelling}   welcome.htm`;
    await submit(fixture, line);
    await waitForPager(fixture.term);
    const normalBeforeClose = visibleBuffer(fixture.term);
    const cursorBeforeClose = {
      x: fixture.term.buffer.normal.cursorX,
      y: fixture.term.buffer.normal.cursorY,
    };

    fixture.send("/");
    fixture.send("ROW-07");
    fixture.send("\r");
    await fixture.term._pagerSession.renderQueue;
    fixture.send("x");
    fixture.key("Tab");
    fixture.send("\x1b[A");
    fixture.key("u", { ctrlKey: true });
    expect(fixture.term.currentLine).toBe(line);
    expect(fixture.term.history).toEqual([line]);

    await closePager(fixture, closeKey);

    const restored = visibleBuffer(fixture.term);
    expect(restored.startsWith(normalBeforeClose)).toBe(true);
    expect(restored.slice(normalBeforeClose.length)).toContain(PROMPT);
    expect(restored).not.toContain("row-07");
    expect(restored).not.toContain("lines 1-");
    expect(fixture.term.buffer.normal.cursorY).toBeGreaterThanOrEqual(cursorBeforeClose.y);
    expect(fixture.term.history).toEqual([line]);
    expect(
      fixture.env.window.dataLayer.filter((event) => event.event === "commandSent")
    ).toEqual([{ event: "commandSent", command: spelling, args: "welcome.htm" }]);

    for (const character of "version --json") fixture.send(character);
    fixture.send("\r");
    await fixture.lastExecution();
    await flush(fixture.term);
    expect(visibleBuffer(fixture.term)).toContain('"version":"9.8.7-test"');
    expect(visibleBuffer(fixture.term).match(/9\.8\.7-test/g)).toHaveLength(1);
  });

  it.each(["less", "more"])(
    "keeps command input, history, completion and analytics exclusively owned while %s is open",
    async (spelling) => {
      const fixture = await createProductionTerminal({ rows: 5, run: true });
      fixture._insertFileToDOM("welcome.htm", numberedContent(8));
      const line = `${spelling}   welcome.htm`;
      await submit(fixture, line);
      await waitForPager(fixture.term);
      const state = {
        currentLine: fixture.term.currentLine,
        history: [...fixture.term.history],
        historyCursor: fixture.term.historyCursor,
        tabBase: fixture.term.tabBase,
        tabIndex: fixture.term.tabIndex,
        tabOptions: [...fixture.term.tabOptions],
      };

      fixture.send("x");
      fixture.key("Tab");
      fixture.send("\x1b[A");
      fixture.key("u", { ctrlKey: true });
      fixture.key("w", { ctrlKey: true });
      fixture.key("d", { altKey: true });
      fixture.send("\x1b");
      fixture.send("\x04");
      await fixture.term._pagerSession.renderQueue;

      expect({
        currentLine: fixture.term.currentLine,
        history: [...fixture.term.history],
        historyCursor: fixture.term.historyCursor,
        tabBase: fixture.term.tabBase,
        tabIndex: fixture.term.tabIndex,
        tabOptions: [...fixture.term.tabOptions],
      }).toEqual(state);
      expect(viewportRows(fixture.term).join("\n")).not.toContain(PROMPT);
      expect(fixture.env.window.dataLayer || []).toHaveLength(0);

      await closePager(fixture, "q");
      expect(fixture.env.window.dataLayer).toEqual([
        { event: "commandSent", command: spelling, args: "welcome.htm" },
      ]);
      fixture.send("\x1b[A");
      expect(fixture.term.currentLine).toBe(line);
      fixture.key("u", { ctrlKey: true });
      for (const character of `${spelling} wel`) fixture.send(character);
      fixture.key("Tab");
      expect(fixture.term.currentLine).toBe(`${spelling} welcome.htm `);
    }
  );

  it.each(["less", "more"])(
    "rejects invalid %s placement and arguments before producer effects",
    async (spelling) => {
      for (const line of [
        `export A=after | ${spelling} | wc -l`,
        `export A=after | ${spelling} extra`,
        `${spelling} welcome.htm | wc -l`,
      ]) {
        const fixture = await createProductionTerminal();
        fixture._insertFileToDOM("welcome.htm", numberedContent(4));
        expect(fixture.term.environment.set("A", "before").ok).toBe(true);
        const preload = vi.spyOn(fixture.term, "preloadCommandAssets");
        const dispatch = vi.spyOn(fixture.term, "dispatchCommand");

        await fixture.term.executeCommandLine(line, { scrollAfter: false });
        await flush(fixture.term);

        expect(preload).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
        expect(fixture.term.environment.entries()).toEqual([["A", "before"]]);
        expect(fixture.term._pagerSession).toBeFalsy();
        const output = visibleBuffer(fixture.term);
        expect(output.match(new RegExp(`${spelling}:`, "g"))).toHaveLength(1);
        expect(output.match(/guest:rootpc ~ \$/g)).toHaveLength(1);
      }
    }
  );

  it.each(["less", "more"])(
    "composes filtered and fitted pipelines and standalone errors for %s",
    async (spelling) => {
      const filtered = await createProductionTerminal({ rows: 4, run: true });
      const filteredExecution = filtered.term.executeCommandLine(
        `tldr | grep -i ai | ${spelling}`,
        { promptAfter: false, scrollAfter: false }
      );
      await waitForPager(filtered.term);
      const filteredFrame = viewportRows(filtered.term);
      expect(filteredFrame.at(-1)).toMatch(/^lines 1-3 of \d+$/);
      expect(filteredFrame.slice(0, -1).join("\n").toLowerCase()).toContain("ai");
      await closePager(filtered, "q");
      await filteredExecution;

      const control = await createProductionTerminal({ rows: 40 });
      const fitted = await createProductionTerminal({ rows: 40 });
      await executeWithoutPrompt(control, "whois | grep -i laelah");
      await executeWithoutPrompt(fitted, `whois | grep -i laelah | ${spelling}`);
      expect(fitted.term._pagerSession).toBeFalsy();
      expect(bufferRows(fitted.term.buffer.normal, false)).toEqual(
        bufferRows(control.term.buffer.normal, false)
      );

      for (const [args, diagnostic] of [
        [[], `${spelling}: usage: ${spelling} FILE`],
        [["welcome.htm", "README.md"], `${spelling}: usage: ${spelling} FILE`],
        [["nosuchfile"], "No such file: nosuchfile"],
      ]) {
        const errors = await createProductionTerminal({ rows: 12 });
        errors.term.user = "root";
        errors._insertFileToDOM("welcome.htm", "one");
        errors._insertFileToDOM("README.md", "two");
        await errors.commands[spelling](args);
        await flush(errors.term);
        expect(errors.term._pagerSession).toBeFalsy();
        expect(visibleBuffer(errors.term)).toContain(diagnostic);
      }
    }
  );

  it.each(["less", "more"])(
    "hands actual collectInput back to a final %s pager only after apply finishes",
    async (spelling) => {
      const fixture = await createProductionTerminal({ cols: 42, rows: 3, run: true });
      await submit(fixture, `apply 1 | ${spelling}`);
      await vi.waitFor(() =>
        expect(visibleBuffer(fixture.term)).toContain("What's your name?")
      );
      expect(fixture.term._pagerSession).toBeFalsy();

      for (const [prompt, value] of [
        ["What's your name?", "Ada Lovelace"],
        ["Email address", "ada@example.test"],
        ["LinkedIn profile URL", ""],
        ["GitHub username", ""],
        ["Why Root? What makes you a great fit?", "pager proof"],
      ]) {
        await vi.waitFor(() => expect(visibleBuffer(fixture.term)).toContain(prompt));
        for (const character of value) fixture.send(character);
        fixture.send("\r");
      }

      await waitForPager(fixture.term);
      expect(viewportRows(fixture.term).at(-1)).toMatch(/^lines 1-2 of \d+$/);
      expect(fixture.env.window.fetch).toHaveBeenCalledOnce();
      await closePager(fixture, "q");
      expect(fixture.term.locked).toBe(false);
      for (const character of "version --json") fixture.send(character);
      fixture.send("\r");
      await fixture.lastExecution();
      await flush(fixture.term);
      expect(visibleBuffer(fixture.term)).toContain('"version":"9.8.7-test"');
    }
  );

  it.each(["less", "more"])(
    "preserves a padded standalone %s submission through paging, recall, history output and analytics",
    async (spelling) => {
      const fixture = await createProductionTerminal({ rows: 5, run: true });
      fixture._insertFileToDOM("welcome.htm", numberedContent(8));
      const line = `  ${spelling}   welcome.htm  `;

      await submit(fixture, line);
      await waitForPager(fixture.term);
      await closePager(fixture, "q");

      expect(fixture.term.history).toEqual([line]);
      expect(fixture.term._historyOutcomes).toEqual([{ paged: true, records: [] }]);
      expect(fixture.env.window.dataLayer).toEqual([
        { event: "commandSent", command: spelling, args: "welcome.htm" },
      ]);
      fixture.send("\x1b[A");
      expect(fixture.term.currentLine).toBe(line);
      fixture.key("u", { ctrlKey: true });
      for (const character of "history") fixture.send(character);
      fixture.send("\r");
      await fixture.lastExecution();
      await flush(fixture.term);
      const renderedEntry = `1000  ${line}`;
      expect(
        bufferRows(fixture.term.buffer.normal, false).some(
          (row) => row.slice(0, renderedEntry.length) === renderedEntry
        )
      ).toBe(true);
    }
  );

  it.each(["less", "more"])(
    "keeps padded rejected %s pipelines raw without producer effects",
    async (spelling) => {
      const fixture = await createProductionTerminal({ run: true });
      expect(fixture.term.environment.set("A", "before").ok).toBe(true);
      const environmentBefore = fixture.term.environment.entries();
      const preload = vi.spyOn(fixture.term, "preloadCommandAssets");
      const dispatch = vi.spyOn(fixture.term, "dispatchCommand");
      const line = `  export   A=after | ${spelling} extra  `;

      await submit(fixture, line);
      await fixture.lastExecution();
      await flush(fixture.term);

      expect(preload).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(fixture.term.environment.entries()).toEqual(environmentBefore);
      expect(fixture.term.history).toEqual([line]);
      expect(fixture.term._historyOutcomes).toEqual([null]);
      expect(fixture.env.window.dataLayer).toEqual([
        {
          event: "commandSent",
          command: "export",
          args: `A=after | ${spelling} extra`,
        },
      ]);
      expect(visibleBuffer(fixture.term).match(new RegExp(`${spelling}:`, "g"))).toHaveLength(1);
      fixture.send("\x1b[A");
      expect(fixture.term.currentLine).toBe(line);
    }
  );

  it.each([
    ["  version   --json  ", "version", "--json", '"buildDate":"2035-06-07"'],
    ["  whois   | grep -i laelah  ", "whois", "| grep -i laelah", "whois laelah"],
  ])(
    "preserves padded ordinary dispatch for %s",
    async (line, command, args, output) => {
      const fixture = await createProductionTerminal({ rows: 40, run: true });
      await submit(fixture, line);
      await fixture.lastExecution();
      await flush(fixture.term);

      expect(fixture.term.history).toEqual([line]);
      expect(fixture.term._historyOutcomes).toEqual([null]);
      expect(fixture.env.window.dataLayer).toEqual([
        { event: "commandSent", command, args },
      ]);
      expect(visibleBuffer(fixture.term)).toContain(output);
      fixture.send("\x1b[A");
      expect(fixture.term.currentLine).toBe(line);
    }
  );

  it("does not record whitespace-only or nonrecording submissions", async () => {
    const fixture = await createProductionTerminal({ run: true });
    await fixture.term.executeCommandLine("   ", { promptAfter: false });
    await fixture.term.executeCommandLine("  version   --json  ", {
      addToHistory: false,
      promptAfter: false,
    });

    expect(fixture.term.history).toEqual([]);
    expect(fixture.term._historyOutcomes).toEqual([]);
    expect(fixture.env.window.dataLayer).toEqual([
      { event: "commandSent", command: "version", args: "--json" },
    ]);
  });

  it("reflows an active real-buffer pager and redraws the normal buffer on close", async () => {
    const fixture = await createProductionTerminal({ cols: 12, rows: 4, run: true });
    fixture._insertFileToDOM(
      "welcome.htm",
      "alpha wraps here\r\nbeta stays\r\ngamma wraps too\r\ndelta\r\nepsilon\r\n"
    );
    await submit(fixture, "less welcome.htm");
    await waitForPager(fixture.term);
    fixture.send("\r");
    await fixture.term._pagerSession.renderQueue;
    const anchor = fixture.term._pagerSession.pager.topSourceLine;

    fixture.fitAddon.fit.mockImplementation(() => fixture.term.resize(18, 5));
    await fixture.term.resizeListener();
    await fixture.term._pagerSession.renderQueue;
    expect(fixture.term._pagerSession.pager.topSourceLine).toBe(anchor);
    expect(viewportRows(fixture.term)).toHaveLength(5);
    expect(viewportRows(fixture.term).at(-1)).toMatch(/^lines \d+-\d+ of \d+( \(END\))?$/);

    await closePager(fixture, "q");
    expect(fixture.term.buffer.active).toBe(fixture.term.buffer.normal);
    expect(visibleBuffer(fixture.term)).not.toContain("lines 1-");
    expect(visibleBuffer(fixture.term)).toContain(PROMPT);
    for (const character of "env") fixture.send(character);
    fixture.send("\r");
    await fixture.lastExecution();
    expect(fixture.term.busy).toBe(false);
  });

  it("replays occurrence-specific fit and page outcomes without producer or side-effect replay", async () => {
    const fixture = await createProductionTerminal({ cols: 40, rows: 4, run: true });
    fixture._insertFileToDOM("welcome.htm", "\x1b[35mfit-one\x1b[0m\r\nfit-two\r\nfit-three\r\n");
    const paddedLine = "  less   welcome.htm  ";
    await fixture.term.executeCommandLine(paddedLine, { promptAfter: false });
    fixture._insertFileToDOM("welcome.htm", numberedContent(5));
    const paged = fixture.term.executeCommandLine(paddedLine, { promptAfter: false });
    await waitForPager(fixture.term);
    fixture.send("q");
    await paged;
    await fixture.term.executeCommandLine("export A=one | less", { promptAfter: false });
    await fixture.term.executeCommandLine("export A=later", { promptAfter: false });

    expect(fixture.term.history.slice(0, 2)).toEqual([paddedLine, paddedLine]);
    expect(fixture.term._historyOutcomes.slice(0, 2)).toEqual([
      { paged: false, records: ["\x1b[35mfit-one\x1b[0m\r\nfit-two\r\nfit-three\r\n"] },
      { paged: true, records: [] },
    ]);
    const history = [...fixture.term.history];
    const analytics = [...fixture.env.window.dataLayer];
    fixture._insertFileToDOM("welcome.htm", "changed-current-content");
    fixture.fitAddon.fit.mockImplementation(() => fixture.term.resize(20, 3));

    await fixture.term._redrawNormalBuffer();
    await fixture.term._redrawNormalBuffer();
    await flush(fixture.term);

    expect(fixture.term._pagerSession).toBeFalsy();
    expect(fixture.term.history).toEqual(history);
    expect(fixture.env.window.dataLayer).toEqual(analytics);
    expect(fixture.term.environment.entries()).toEqual([["A", "later"]]);
    const replay = visibleBuffer(fixture.term);
    expect(replay).toContain("fit-one");
    expect(replay).not.toContain("row-01");
    expect(replay).not.toContain("changed-current-content");
  });

  it.each(["less", "more"])(
    "runs an overflowing %s deep link noninteractively across replay",
    async (spelling) => {
      const fixture = await createProductionTerminal({
        cols: 20,
        rows: 3,
        url: `https://www.root.vc/#${spelling}-welcome.htm`,
      });
      fixture._insertFileToDOM("welcome.htm", numberedContent(5));
      const control = await createProductionTerminal({ cols: 20, rows: 3 });
      control._insertFileToDOM("welcome.htm", numberedContent(5));
      await executeWithoutPrompt(control, "cat welcome.htm");

      expect(fixture.term.deepLink).toBe(`${spelling} welcome.htm`);
      await fixture.term.runDeepLink();
      await flush(fixture.term);
      expect(fixture.term._pagerSession).toBeFalsy();
      expect(bufferRows(fixture.term.buffer.normal, false)).toEqual(
        bufferRows(control.term.buffer.normal, false)
      );
      expect(fixture.term.history).toEqual([]);
      const analytics = [...fixture.env.window.dataLayer];

      fixture.term.reset();
      await fixture.term.runDeepLink({ replay: true });
      await flush(fixture.term);
      expect(fixture.term._pagerSession).toBeFalsy();
      expect(fixture.term.history).toEqual([]);
      expect(fixture.env.window.dataLayer).toEqual(analytics);
    }
  );
});

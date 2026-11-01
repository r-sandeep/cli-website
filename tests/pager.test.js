import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;
let Pager;

afterEach(() => {
  if (env) env.cleanup();
  env = null;
});

function loadPager() {
  env = createBrowserEnv({ globals: { Terminal } });
  env.loadScripts(["js/pager.js"]);
  ({ Pager } = env.exportValues(["Pager"]));
}

function terminalRows(term) {
  const buffer = term.buffer.active;
  const rows = [];
  for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? "");
  }
  return rows;
}

async function pagerFor(lines, dimensions = { cols: 5, rows: 4 }) {
  if (!Pager) loadPager();
  return Pager.create(lines, dimensions);
}

function keys(pager, input) {
  for (const key of input) pager.handleKey(key);
  return pager.frame();
}

describe("Pager cell layout", () => {
  it("uses the exact fit boundary and preserves visible line structure", async () => {
    loadPager();
    const fitted = await pagerFor(["one", "two", "three"]);
    const paged = await pagerFor(["one", "two", "three", "four"]);
    const structured = await pagerFor([
      "\x1b[31mabcdef\x1b[0m\r\n\r\ntail\r\n",
    ]);

    expect(fitted.shouldPage).toBe(false);
    expect(fitted.frame()).toMatchObject({
      rows: ["one", "two", "three"],
      status: "lines 1-3 of 3 (END)",
      total: 3,
    });
    expect(paged.shouldPage).toBe(true);
    expect(paged.frame()).toMatchObject({
      rows: ["one", "two", "three"],
      status: "lines 1-3 of 4",
      total: 4,
    });
    expect(structured.sourceLines).toEqual(["abcdef", "", "tail"]);
    expect(structured.frame()).toMatchObject({
      rows: ["abcde", "f", ""],
      status: "lines 1-3 of 4",
      total: 4,
    });
    expect(structured.screenLines.map((row) => row.text)).toEqual([
      "abcde",
      "f",
      "",
      "tail",
    ]);
    expect(structured.screenLines.map((row) => row.sourceIndex)).toEqual([
      0,
      0,
      1,
      2,
    ]);
  });

  it("follows real xterm cell semantics for tabs, wide and combining text", async () => {
    loadPager();
    const pager = await pagerFor(["a\tb", "界e\u0301 Z", "12345", ""]);

    expect(pager.sourceLines).toEqual(["a\tb", "界e\u0301 Z", "12345"]);
    expect(pager.screenLines.map((row) => row.text)).toEqual([
      "a   b",
      "界e\u0301 Z",
      "12345",
    ]);
    expect(pager.screenLines.map((row) => row.sourceIndex)).toEqual([0, 1, 2]);

    await pager.relayout({ cols: 4, rows: 4 });
    expect(pager.screenLines.map((row) => row.text)).toEqual([
      "a  b",
      "界e\u0301 ",
      "Z",
      "1234",
      "5",
    ]);

    const exactWidth = await pagerFor(["12345", "next"], { cols: 5, rows: 4 });
    expect(exactWidth.screenLines.map((row) => row.text)).toEqual([
      "12345",
      "next",
    ]);
  });

  it("anchors the top source line across narrower and wider relayouts", async () => {
    loadPager();
    const pager = await pagerFor([
      "alpha wraps here",
      "beta stays",
      "gamma wraps too",
      "delta",
      "epsilon",
    ], { cols: 6, rows: 4 });
    pager.handleKey("ArrowDown");
    expect(pager.topSourceLine).toBe(0);

    await pager.relayout({ cols: 9, rows: 5 });
    expect(pager.topSourceLine).toBe(0);
    expect(pager.frame().sourceIndices[0]).toBe(0);

    pager.handleKey("G");
    const nearEndSource = pager.topSourceLine;
    await pager.relayout({ cols: 4, rows: 4 });
    expect(pager.topSourceLine).toBe(nearEndSource);
    expect(pager.frame().rows).toHaveLength(3);

    await pager.relayout({ cols: 50, rows: 4 });
    expect(pager.top).toBe(pager.maxTop);
    expect(pager.topSourceLine).toBe(nearEndSource);
    expect(pager.frame().rows).toHaveLength(3);
    expect(pager.frame().last).toBe(pager.total);
  });

  it("renders complete frames through a real xterm write callback", async () => {
    loadPager();
    const pager = await pagerFor(["one", "two", "three", "four"], {
      cols: 20,
      rows: 4,
    });
    const term = new Terminal({ cols: 20, rows: 4 });

    await pager.render(term);

    expect(terminalRows(term)).toEqual([
      "one",
      "two",
      "three",
      "lines 1-3 of 4",
    ]);
    term.dispose();
  });
});

describe("Pager navigation", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `L${index + 1}`);

  it.each([" ", "Space", "f", "PageDown"])(
    "%s advances by a page and clamps to the last full screen",
    async (key) => {
      const pager = await pagerFor(lines);
      expect(pager.frame().top).toBe(0);
      expect(pager.handleKey(key).frame.top).toBe(3);
      expect(pager.handleKey(key).frame.top).toBe(6);
      expect(pager.handleKey(key).frame.top).toBe(7);
      expect(pager.handleKey(key).frame).toMatchObject({
        rows: ["L8", "L9", "L10"],
        status: "lines 8-10 of 10 (END)",
        top: 7,
      });
    }
  );

  it.each(["b", "PageUp"])("%s moves back by a page and clamps", async (key) => {
    const pager = await pagerFor(lines);
    pager.handleKey("G");
    expect(pager.handleKey(key).frame.top).toBe(4);
    expect(pager.handleKey(key).frame.top).toBe(1);
    expect(pager.handleKey(key).frame.top).toBe(0);
    expect(pager.handleKey(key).frame.top).toBe(0);
  });

  it.each(["ArrowDown", "j", "Enter"])("%s moves down one line", async (key) => {
    const pager = await pagerFor(lines);
    expect(pager.handleKey(key).frame.top).toBe(1);
    pager.handleKey("G");
    expect(pager.handleKey(key).frame.top).toBe(7);
  });

  it.each(["ArrowUp", "k"])("%s moves up one line", async (key) => {
    const pager = await pagerFor(lines);
    expect(pager.handleKey(key).frame.top).toBe(0);
    pager.handleKey("G");
    expect(pager.handleKey(key).frame.top).toBe(6);
  });

  it.each(["g", "Home"])("%s goes to the first screen", async (key) => {
    const pager = await pagerFor(lines);
    pager.handleKey("G");
    expect(pager.handleKey(key).frame).toMatchObject({
      rows: ["L1", "L2", "L3"],
      status: "lines 1-3 of 10",
      top: 0,
    });
  });

  it.each(["G", "End"])("%s goes to the last full screen", async (key) => {
    const pager = await pagerFor(lines);
    expect(pager.handleKey(key).frame).toMatchObject({
      rows: ["L8", "L9", "L10"],
      status: "lines 8-10 of 10 (END)",
      top: 7,
    });
    expect(pager.handleKey(key).frame.top).toBe(7);
  });

  it("interleaves page, line and endpoint movement deterministically", async () => {
    const pager = await pagerFor(lines);
    expect(keys(pager, ["f", "j", "PageDown", "k", "Home", "ArrowDown"]).top).toBe(1);
  });
});

describe("Pager literal search", () => {
  it("searches later source lines literally and case-insensitively", async () => {
    const pager = await pagerFor([
      "current target wraps",
      "middle",
      "A.*B first",
      "later a.*b second",
      "filler",
      "final A.*B",
    ]);

    expect(pager.handleKey("n").frame.top).toBe(0);
    keys(pager, ["/", "a", ".", "*", "b", "Enter"]);
    expect(pager.frame()).toMatchObject({
      rows: ["A.*B ", "first", "later"],
      top: 6,
      sourceIndices: [2, 2, 3],
    });

    pager.handleKey("n");
    expect(pager.frame()).toMatchObject({
      rows: ["later", " a.*b", " seco"],
      top: 8,
      sourceIndices: [3, 3, 3],
    });

    keys(pager, ["/", "Enter"]);
    expect(pager.frame()).toMatchObject({
      rows: ["r", "final", " A.*B"],
      status: "lines 14-16 of 16 (END)",
      top: 13,
      sourceIndices: [4, 5, 5],
    });
  });

  it("skips the current source line even from one of its wrapped rows", async () => {
    const pager = await pagerFor([
      "target in current wrapped line",
      "other",
      "next TARGET line",
      "tail",
    ]);
    pager.handleKey("ArrowDown");
    keys(pager, ["/", "t", "a", "r", "g", "e", "t", "Enter"]);

    expect(pager.frame().sourceIndices[0]).toBe(2);
    expect(pager.frame().rows[0]).toBe("next ");
  });

  it("clamps a near-end match to a complete final screen", async () => {
    const pager = await pagerFor(["start", "one", "two", "three", "final hit"]);
    keys(pager, ["/", "h", "i", "t", "Enter"]);
    expect(pager.frame()).toMatchObject({
      rows: ["three", "final", " hit"],
      status: "lines 4-6 of 6 (END)",
      top: 3,
    });
    expect(pager.frame().sourceIndices).toEqual([3, 4, 4]);
  });
});

describe("Pager search editing and feedback", () => {
  it("edits with Backspace before searching", async () => {
    const pager = await pagerFor(["start", "one", "target", "two", "three"]);
    keys(pager, ["/", "t", "a", "r", "g", "e", "t", "x"]);
    expect(pager.frame().status).toBe("/targetx");
    pager.handleKey("Backspace");
    expect(pager.frame().status).toBe("/target");
    pager.handleKey("Enter");
    expect(pager.frame().rows[0]).toBe("targe");
    expect(pager.frame().sourceIndices[0]).toBe(2);
  });

  it.each(["Escape", "Ctrl+C"])("%s cancels search without moving or closing", async (key) => {
    const pager = await pagerFor(["one", "two", "three", "four"]);
    const initial = pager.frame();
    keys(pager, ["/", "e", "d", "i", "t"]);
    const result = pager.handleKey(key);
    expect(result.action).toBe("render");
    expect(result.frame).toEqual(initial);
    expect(pager.mode).toBe("display");
  });

  it("keeps position on failure and lets the next key clear feedback and move", async () => {
    const pager = await pagerFor(["one", "two", "three", "four", "five"]);
    const initialRows = pager.frame().rows;
    keys(pager, ["/", "z", "z", "q", "x", "Enter"]);
    expect(pager.frame()).toMatchObject({
      rows: initialRows,
      status: "Pattern not found: zzqx",
      top: 0,
    });
    pager.handleKey("ArrowDown");
    expect(pager.frame()).toMatchObject({
      rows: ["two", "three", "four"],
      status: "lines 2-4 of 5",
      top: 1,
    });
  });

  it("empty Enter with no prior pattern is inert", async () => {
    const pager = await pagerFor(["one", "two", "three", "four"]);
    const initial = pager.frame();
    keys(pager, ["/", "Enter"]);
    expect(pager.frame()).toEqual(initial);
    expect(pager.lastSearch).toBeNull();
  });
});

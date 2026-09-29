import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadTerminalTips() {
  env = createBrowserEnv();
  env.loadScripts(["js/terminal-tips.js"]);
  return env.exportValues(["TERMINAL_TIPS", "filterTerminalTips"]);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal tips model", () => {
  it("defines exactly the three tips in stable order", () => {
    const { TERMINAL_TIPS } = loadTerminalTips();

    expect(TERMINAL_TIPS).toEqual([
      { title: "help", description: "type help to list commands" },
      { title: "version", description: "type version to view build identity" },
      {
        title: "shortcuts",
        description: "type man shortcuts to view editing shortcuts",
      },
    ]);
  });

  it("returns every tip in stable order for an empty query", () => {
    const { TERMINAL_TIPS, filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("")).toEqual(TERMINAL_TIPS);
    expect(filterTerminalTips("").map((tip) => tip.title)).toEqual([
      "help",
      "version",
      "shortcuts",
    ]);
  });

  it("matches titles without regard to case", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("VeRsIoN").map((tip) => tip.title)).toEqual([
      "version",
    ]);
  });

  it("trims surrounding whitespace before matching", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("  shortcuts  ").map((tip) => tip.title)).toEqual([
      "shortcuts",
    ]);
  });

  it("matches descriptions", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("build identity").map((tip) => tip.title)).toEqual([
      "version",
    ]);
  });

  it("treats punctuation as literal text rather than a regular expression", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips(".")).toEqual([]);
  });

  it("returns no tips for an unmatched query", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("not a terminal tip")).toEqual([]);
  });

  it("preserves model values and order across filtering", () => {
    const { TERMINAL_TIPS, filterTerminalTips } = loadTerminalTips();
    const before = TERMINAL_TIPS.map((tip) => ({ ...tip }));

    expect(filterTerminalTips("type").map((tip) => tip.title)).toEqual([
      "help",
      "version",
      "shortcuts",
    ]);
    expect(TERMINAL_TIPS).toEqual(before);
  });
});

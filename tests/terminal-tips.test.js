import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadTerminalTips() {
  env = createBrowserEnv();
  env.loadScript("js/terminal-tips.js");
  return env.exportValues([
    "TERMINAL_TIPS_NO_MATCH",
    "terminalTips",
    "filterTerminalTips",
  ]);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal tips model", () => {
  it("defines only the three required tips in stable order", () => {
    const { terminalTips } = loadTerminalTips();

    expect(terminalTips).toEqual([
      {
        id: "help",
        title: "help",
        description: "type help to list commands",
      },
      {
        id: "version",
        title: "version",
        description: "type version to view build identity",
      },
      {
        id: "shortcuts",
        title: "shortcuts",
        description: "type man shortcuts to view editing shortcuts",
      },
    ]);
    expect(Object.isFrozen(terminalTips)).toBe(true);
    expect(terminalTips.every(Object.isFrozen)).toBe(true);
  });

  it("returns the stable full list for an empty or whitespace-only query", () => {
    const { filterTerminalTips, terminalTips } = loadTerminalTips();

    expect(filterTerminalTips("")).toBe(terminalTips);
    expect(filterTerminalTips(" \t\n ")).toBe(terminalTips);
  });

  it("trims and folds case for title matches", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("  HeLP  ").map((tip) => tip.id)).toEqual([
      "help",
    ]);
  });

  it("matches case-insensitive description substrings", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("BuIlD IdEnTiTy").map((tip) => tip.id)).toEqual([
      "version",
    ]);
    expect(filterTerminalTips("editing shortcuts").map((tip) => tip.id)).toEqual([
      "shortcuts",
    ]);
  });

  it("does not match text spanning the title and description boundary", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("help type")).toEqual([]);
  });

  it("treats punctuation literally instead of as a regular expression", () => {
    const { filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips(".")).toEqual([]);
    expect(filterTerminalTips("[help]")).toEqual([]);
    expect(filterTerminalTips(".*")).toEqual([]);
  });

  it("returns no results and exposes the unmatched-results copy", () => {
    const { TERMINAL_TIPS_NO_MATCH, filterTerminalTips } = loadTerminalTips();

    expect(filterTerminalTips("does.not.exist")).toEqual([]);
    expect(TERMINAL_TIPS_NO_MATCH).toBe("No matching tips");
  });
});

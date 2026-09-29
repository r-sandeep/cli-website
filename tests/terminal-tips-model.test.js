import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadTipsModel() {
  env = createBrowserEnv();
  env.loadScript("js/terminal-tips-model.js");
  return env.exportValues(["terminalTips", "filterTerminalTips"]);
}

function plainTips(tips) {
  return Array.from(tips, ({ title, description }) => ({ title, description }));
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal tips model", () => {
  it("contains exactly the three required tips in stable order", () => {
    const { terminalTips } = loadTipsModel();

    expect(plainTips(terminalTips)).toEqual([
      { title: "help", description: "type help to list commands" },
      { title: "version", description: "type version to view build identity" },
      {
        title: "shortcuts",
        description: "type man shortcuts to view editing shortcuts",
      },
    ]);
  });

  it.each([
    ["mixed-case title", "VeRsIoN", ["version"]],
    ["surrounding whitespace", "  help  ", ["help"]],
    ["mixed-case description", "  VIEW BUILD  ", ["version"]],
    ["description text", "editing shortcuts", ["shortcuts"]],
    ["regex-like punctuation is literal", ".*", []],
    ["unmatched text", "missing tip", []],
  ])("filters %s", (_label, query, expectedTitles) => {
    const { filterTerminalTips } = loadTipsModel();

    expect(Array.from(filterTerminalTips(query), (tip) => tip.title)).toEqual(
      expectedTitles
    );
  });

  it.each(["", "   "])("returns every tip for empty input %j", (query) => {
    const { filterTerminalTips } = loadTipsModel();

    expect(Array.from(filterTerminalTips(query), (tip) => tip.title)).toEqual([
      "help",
      "version",
      "shortcuts",
    ]);
  });

  it("preserves order and keeps the shared model immutable", () => {
    const { filterTerminalTips, terminalTips } = loadTipsModel();
    const before = plainTips(terminalTips);

    const matches = filterTerminalTips("type");
    expect(Array.from(matches, (tip) => tip.title)).toEqual([
      "help",
      "version",
      "shortcuts",
    ]);
    expect(matches).not.toBe(terminalTips);

    matches.pop();
    expect(plainTips(terminalTips)).toEqual(before);
    expect(Object.isFrozen(terminalTips)).toBe(true);
    expect(Array.from(terminalTips, Object.isFrozen)).toEqual([true, true, true]);
  });
});
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadTerminalTipsModel() {
  env = createBrowserEnv();
  env.loadScript("js/terminal-tips-model.js");
  return env.exportValues(["terminalTips", "filterTerminalTips"]);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("terminal tips model", () => {
  it("contains only the three immutable tips in stable display order", () => {
    const { terminalTips } = loadTerminalTipsModel();

    expect(terminalTips).toEqual([
      { title: "help", description: "type help to list commands" },
      {
        title: "version",
        description: "type version to view build identity",
      },
      {
        title: "shortcuts",
        description: "type man shortcuts to view editing shortcuts",
      },
    ]);
    expect(terminalTips).toHaveLength(3);
    expect(Object.isFrozen(terminalTips)).toBe(true);
    terminalTips.forEach((tip) => expect(Object.isFrozen(tip)).toBe(true));
  });

  it.each([
    {
      partition: "empty query",
      query: "",
      expectedTitles: ["help", "version", "shortcuts"],
    },
    {
      partition: "mixed case",
      query: "VeRsIoN",
      expectedTitles: ["version"],
    },
    {
      partition: "surrounding whitespace",
      query: "  VIEW BUILD  ",
      expectedTitles: ["version"],
    },
    {
      partition: "literal punctuation",
      query: "[",
      expectedTitles: [],
    },
    {
      partition: "unmatched text",
      query: "missing tip",
      expectedTitles: [],
    },
    {
      partition: "title substring",
      query: "short",
      expectedTitles: ["shortcuts"],
    },
    {
      partition: "description substring with stable ordering",
      query: "type",
      expectedTitles: ["help", "version", "shortcuts"],
    },
  ])("filters the $partition partition", ({ query, expectedTitles }) => {
    const { filterTerminalTips } = loadTerminalTipsModel();

    expect(filterTerminalTips(query).map((tip) => tip.title)).toEqual(
      expectedTitles
    );
  });
});

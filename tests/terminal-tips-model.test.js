import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;
let model;

beforeEach(() => {
  env = createBrowserEnv();
  env.loadScripts(["js/terminal-tips-model.js"]);
  model = env.exportValues(["TerminalTips"]).TerminalTips;
});

afterEach(() => {
  env.cleanup();
});

describe("Terminal tips model", () => {
  const expectedTips = [
    { title: "help", description: "type help to list commands" },
    { title: "version", description: "type version to view build identity" },
    {
      title: "shortcuts",
      description: "type man shortcuts to view editing shortcuts",
    },
  ];

  it("exposes exactly the three tips in stable order", () => {
    expect(model.tips).toEqual(expectedTips);
    expect(model.tips).toHaveLength(3);
  });

  it.each([
    ["mixed-case title", "VeRsIoN", [expectedTips[1]]],
    ["surrounding whitespace", "  LIST COMMANDS  ", [expectedTips[0]]],
    ["description text", "editing shortcuts", [expectedTips[2]]],
    ["literal punctuation", ".*", []],
    ["unmatched text", "deploy", []],
  ])("filters %s with literal case-insensitive matching", (_name, query, expected) => {
    expect(model.filterTips(query)).toEqual(expected);
  });

  it.each(["", "   "])("returns every tip for an empty normalized query %j", (query) => {
    expect(model.filterTips(query)).toEqual(expectedTips);
  });

  it("returns a detached result without changing stable model order", () => {
    const result = model.filterTips("");
    result.reverse();

    expect(model.tips).toEqual(expectedTips);
  });
});

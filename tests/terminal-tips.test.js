import { describe, expect, it } from "vitest";
import terminalTipsModule from "../config/terminal-tips.js";

const { terminalTips, filterTerminalTips } = terminalTipsModule;

const expectedTips = [
  {
    title: "help",
    description: "Type help to list commands.",
  },
  {
    title: "version",
    description: "Type version to view build identity.",
  },
  {
    title: "shortcuts",
    description: "Type man shortcuts to view editing shortcuts.",
  },
];

describe("terminal tips model", () => {
  it("has exactly the immutable tips in stable display order", () => {
    expect(terminalTips).toEqual(expectedTips);
    expect(terminalTips).toHaveLength(3);
    expect(Object.isFrozen(terminalTips)).toBe(true);
    expect(terminalTips.every(Object.isFrozen)).toBe(true);
  });
});

describe("filterTerminalTips", () => {
  it("returns the stable model for an empty or whitespace-only query", () => {
    expect(filterTerminalTips("")).toBe(terminalTips);
    expect(filterTerminalTips(" \t\n ")).toBe(terminalTips);
  });

  it("matches known text across titles and descriptions", () => {
    expect(filterTerminalTips("help")).toEqual([expectedTips[0]]);
    expect(filterTerminalTips("build identity")).toEqual([expectedTips[1]]);
    expect(filterTerminalTips("editing shortcuts")).toEqual([expectedTips[2]]);
  });

  it("trims surrounding whitespace and matches without case sensitivity", () => {
    expect(filterTerminalTips("  VeRsIoN  ")).toEqual([expectedTips[1]]);
    expect(filterTerminalTips("  TYPE MAN SHORTCUTS  ")).toEqual([
      expectedTips[2],
    ]);
  });

  it("treats punctuation as literal substring text", () => {
    expect(filterTerminalTips(".")).toEqual(expectedTips);
    expect(filterTerminalTips("[")).toEqual([]);
  });

  it("returns no entries for an unmatched query", () => {
    expect(filterTerminalTips("does not exist")).toEqual([]);
  });
});

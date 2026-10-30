import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;
afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

function loadSequence() {
  env = createBrowserEnv();
  env.loadScript("js/sequence.js");
  return env.exportValues(["Sequence"]).Sequence;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("typed-line sequence scanning", () => {
  it.each([
    [
      "echo a;echo b",
      ["echo a", "echo b"],
      [";"],
      [[0, 6], [7, 13]],
    ],
    [
      "  echo a ; echo b  ",
      ["  echo a ", " echo b  "],
      [";"],
      [[0, 9], [10, 19]],
    ],
    [
      "true&&echo a||echo b",
      ["true", "echo a", "echo b"],
      ["&&", "||"],
      [[0, 4], [6, 12], [14, 20]],
    ],
  ])("preserves raw spans for %s", (line, sources, operators, spans) => {
    const result = plain(loadSequence().scan(line));

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.operators).toEqual(operators);
    expect(result.segments.map((segment) => segment.source)).toEqual(sources);
    expect(result.segments.map(({ start, end }) => [start, end])).toEqual(spans);
  });

  it.each([
    ["echo a & echo b", "echo a & echo b"],
    ["whois root | grep root", "whois root | grep root"],
    ['echo "a; b && c"', 'echo "a; b && c"'],
    ["echo 'a; b && c'", "echo 'a; b && c'"],
    ['echo "a || b"', 'echo "a || b"'],
    ["echo 'a || b'", "echo 'a || b'"],
  ])("leaves non-sequence and quoted syntax untouched: %s", (line, source) => {
    const result = plain(loadSequence().scan(line));

    expect(result).toEqual({
      ok: true,
      error: null,
      segments: [{ source, start: 0, end: line.length }],
      operators: [],
    });
  });

  it.each([
    ["; echo a", ";"],
    ["&& echo a", "&&"],
    ["|| echo a", "||"],
    ["echo a && && echo b", "&&"],
    ["echo a || || echo b", "||"],
    ["echo a && ; echo b", ";"],
    ["echo a ;; echo b", ";"],
    ["echo a ; || echo b", "||"],
    ["echo a &&", "&&"],
    ["echo a ||", "||"],
    ["echo a;;", ";"],
    ["echo a; ;", ";"],
  ])("rejects the complete malformed line before producing a plan: %s", (line, operator) => {
    const result = plain(loadSequence().scan(line));

    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      operator,
      message: `sequence: unexpected ${operator}`,
    });
    expect(result.segments).toEqual([]);
    expect(result.operators).toEqual([]);
  });

  it.each(["echo a;", "echo a;   "]) (
    "allows one trailing semicolon and retains the executable raw segment: %s",
    (line) => {
      const result = plain(loadSequence().scan(line));

      expect(result.ok).toBe(true);
      expect(result.error).toBeNull();
      expect(result.operators).toEqual([";"]);
      expect(result.segments).toEqual([{ source: "echo a", start: 0, end: 6 }]);
    }
  );

  it("finds the active raw segment without treating quoted operators as boundaries", () => {
    const sequence = loadSequence();

    expect(plain(sequence.segmentAt("echo 'a; b' &&  whoa"))).toEqual({
      source: "  whoa",
      start: 14,
      end: 20,
    });
    expect(plain(sequence.segmentAt("echo a || whoami trailing", 16))).toEqual({
      source: " whoami",
      start: 9,
      end: 16,
    });
  });
});

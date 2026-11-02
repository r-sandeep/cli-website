import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;
let pipeline;

beforeEach(() => {
  env = createBrowserEnv();
  env.loadScripts(["js/pipeline.js"]);
  pipeline = env.exportValues(["Pipeline"]).Pipeline;
});

afterEach(() => {
  env.cleanup();
});

function compile(commandLine) {
  return pipeline.validatePipeline(pipeline.parsePipeline(commandLine));
}

function run(commandLine, lines, options) {
  const validated = compile(commandLine);
  expect(validated.ok).toBe(true);
  return pipeline.applyPipeline(lines, validated.filters, options);
}

describe("pipeline grammar", () => {
  it("returns null for a standalone command", () => {
    expect(pipeline.parsePipeline("grep needle README.md")).toBeNull();
  });

  it("does not treat a quoted pipe in a standalone command as a pipeline", () => {
    expect(pipeline.parsePipeline("echo '|'")).toBeNull();
  });

  it("trims a producer and preserves every stage in source order", () => {
    expect(pipeline.parsePipeline("  cmd --flag  | grep a | head 3 | wc -l ")).toEqual({
      producer: "cmd --flag",
      stages: [
        { source: "grep a", name: "grep", args: ["a"] },
        { source: "head 3", name: "head", args: ["3"] },
        { source: "wc -l", name: "wc", args: ["-l"] },
      ],
    });
  });

  it("parses without invoking any command globals", () => {
    env.window.commands = { cmd: vi.fn() };
    pipeline.parsePipeline("cmd | grep value");
    expect(env.window.commands.cmd).not.toHaveBeenCalled();
  });
});

describe("grep", () => {
  it.each([
    ["literal metacharacters", "cmd | grep a.b", ["a.b", "axb"], ["a.b"]],
    ["case-sensitive default", "cmd | grep Alpha", ["Alpha", "alpha"], ["Alpha"]],
    ["case-insensitive -i", "cmd | grep -i Alpha", ["Alpha", "alpha", "beta"], ["Alpha", "alpha"]],
    ["inverse -v", "cmd | grep -v cat", ["cat", "dog", "bobcat"], ["dog"]],
    ["space-containing pattern", "cmd | grep deep tech", ["deep tech", "deep", "tech"], ["deep tech"]],
  ])("supports %s", (_name, commandLine, input, expected) => {
    expect(run(commandLine, input)).toEqual({ lines: expected, error: null });
  });

  it("numbers retained lines by their positions in the incoming stage", () => {
    expect(run("cmd | grep -n keep", ["drop", "keep one", "drop", "keep two"])).toEqual({
      lines: ["2:keep one", "4:keep two"],
      error: null,
    });
  });

  it("supports clustered -i, -v, and -n flags", () => {
    expect(run("cmd | grep -ivn skip", ["SKIP", "keep", "skip", "also keep"])).toEqual({
      lines: ["2:keep", "4:also keep"],
      error: null,
    });
  });

  it("can match projected visible text while retaining the original line", () => {
    const input = [{ rendered: "\u001b[31mAlpha\u001b[0m", text: "Alpha" }];
    expect(run("cmd | grep -i alpha", input, { getText: (line) => line.text })).toEqual({
      lines: input,
      error: null,
    });
  });

  it("supports a rendering-aware numbering callback", () => {
    const input = [{ rendered: "value", text: "value" }];
    const result = run("cmd | grep -n value", input, {
      getText: (line) => line.text,
      prefixLine: (line, number) => ({ ...line, rendered: `${number}:${line.rendered}` }),
    });
    expect(result.lines).toEqual([{ rendered: "1:value", text: "value" }]);
  });
});

describe("head and tail", () => {
  const manyLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);

  it("defaults head and tail to 10 lines", () => {
    expect(run("cmd | head", manyLines).lines).toEqual(manyLines.slice(0, 10));
    expect(run("cmd | tail", manyLines).lines).toEqual(manyLines.slice(-10));
  });

  it("keeps the requested first or last positive number of lines", () => {
    expect(run("cmd | head 1", manyLines).lines).toEqual(["line 1"]);
    expect(run("cmd | tail 3", manyLines).lines).toEqual(manyLines.slice(-3));
  });

  it.each(["0", "-1", "1.5", "two", "0x10", "1e2", "2 3"])(
    "classifies invalid count %s as a pre-dispatch error",
    (count) => {
      const result = compile(`cmd | head ${count}`);
      expect(result.ok).toBe(false);
      expect(result.error.type).toBe("pre-dispatch");
      expect(result.error.stageName).toBe("head");
      expect(result.error.message).toContain("positive base-10 integer");
    }
  );

  it.each(["0", "two"])(
    "classifies invalid tail count %s as a pre-dispatch error",
    (count) => {
      const result = compile(`cmd | tail ${count}`);
      expect(result.ok).toBe(false);
      expect(result.error.type).toBe("pre-dispatch");
      expect(result.error.stageName).toBe("tail");
      expect(result.error.message).toContain("positive base-10 integer");
    }
  );
});

describe("wc, empty input, and composition", () => {
  it("supports only wc -l and counts incoming lines", () => {
    expect(run("cmd | wc -l", ["one", "two", "three"])).toEqual({
      lines: ["3"],
      error: null,
    });
    expect(run("cmd | wc -l", [])).toEqual({ lines: ["0"], error: null });
    expect(compile("cmd | wc").error.type).toBe("pre-dispatch");
  });

  it.each(["grep value", "head 3", "tail 3"])(
    "%s emits nothing for empty input",
    (filter) => {
      expect(run(`cmd | ${filter}`, [])).toEqual({ lines: [], error: null });
    }
  );

  it("applies three filter stages strictly left to right", () => {
    expect(
      run("cmd | grep -i a | head 3 | tail 2", [
        "zero",
        "Alpha",
        "beta",
        "Gamma",
        "delta",
      ])
    ).toEqual({ lines: ["beta", "Gamma"], error: null });
  });
});

describe("sort", () => {
  it.each([
    ["ascending", "cmd | sort", ["beta", "alpha", "gamma"], ["alpha", "beta", "gamma"]],
    ["reverse", "cmd | sort -r", ["beta", "alpha", "gamma"], ["gamma", "beta", "alpha"]],
    ["separate flags", "cmd | sort -r -n", ["2 two", "10 ten", "1 one"], ["10 ten", "2 two", "1 one"]],
    ["clustered flags", "cmd | sort -rn", ["2 two", "10 ten", "1 one"], ["10 ten", "2 two", "1 one"]],
    ["unique", "cmd | sort -u", ["beta", "alpha", "beta", "alpha"], ["alpha", "beta"]],
    ["all clustered flags", "cmd | sort -rnu", ["2 first", "10 ten", "2 first", "2 second", "none", "none"], ["10 ten", "2 first", "2 second", "none"]],
  ])("supports %s sorting", (_name, commandLine, input, expected) => {
    expect(run(commandLine, input)).toEqual({ lines: expected, error: null });
  });

  it.each(["-x", "-rx", "--reverse", "value", "-"])(
    "rejects unsupported or positional argument %s during compilation",
    (argument) => {
      const result = compile(`cmd | sort ${argument}`);
      expect(result.ok).toBe(false);
      expect(result.error).toEqual({
        type: "pre-dispatch",
        stageName: "sort",
        message: "sort: supported flags are -r, -n, -u",
      });
    }
  );

  it("sorts leading signed and decimal numbers while keeping nonnumeric and equal keys stable", () => {
    const input = ["zebra", "2 first", "apple", "-1 below", "2 second", ".5 half", "10ten"];
    expect(run("cmd | sort -n", input).lines).toEqual([
      "zebra",
      "apple",
      "-1 below",
      ".5 half",
      "2 first",
      "2 second",
      "10ten",
    ]);
  });

  it("reverses numeric key ordering without reversing equal-key groups", () => {
    expect(run("cmd | sort -rn", ["2 first", "none first", "2 second", "none second", "10 ten"]).lines)
      .toEqual(["10 ten", "2 first", "2 second", "none first", "none second"]);
  });

  it("compares projected visible text and preserves the first styled representative", () => {
    const redAlpha = { rendered: "\u001b[31malpha\u001b[0m", text: "alpha" };
    const blueAlpha = { rendered: "\u001b[34malpha\u001b[0m", text: "alpha" };
    const beta = { rendered: "\u001b[32mbeta\u001b[0m", text: "beta" };
    expect(run("cmd | sort -u", [beta, redAlpha, blueAlpha], { getText: (line) => line.text }).lines)
      .toEqual([redAlpha, beta]);
  });

  it("emits no lines for empty input", () => {
    expect(run("cmd | sort -rnu", [])).toEqual({ lines: [], error: null });
  });
});

describe("uniq", () => {
  it.each([
    ["adjacent runs", "cmd | uniq", ["a", "a", "b", "a"], ["a", "b", "a"]],
    ["counts", "cmd | uniq -c", ["a", "a", "b", "a"], ["2 a", "1 b", "1 a"]],
    ["duplicates only", "cmd | uniq -d", ["a", "a", "b", "c", "c"], ["a", "c"]],
    ["clustered count and duplicates", "cmd | uniq -cd", ["a", "a", "b", "c", "c", "c"], ["2 a", "3 c"]],
    ["separate count and duplicates", "cmd | uniq -c -d", ["a", "a", "b"], ["2 a"]],
  ])("supports %s", (_name, commandLine, input, expected) => {
    expect(run(commandLine, input)).toEqual({ lines: expected, error: null });
  });

  it.each(["-x", "-cx", "--count", "value", "-"])(
    "rejects unsupported or positional argument %s during compilation",
    (argument) => {
      const result = compile(`cmd | uniq ${argument}`);
      expect(result.ok).toBe(false);
      expect(result.error).toEqual({
        type: "pre-dispatch",
        stageName: "uniq",
        message: "uniq: supported flags are -c, -d",
      });
    }
  );

  it("groups by projected visible text and preserves the first styled line", () => {
    const red = { rendered: "\u001b[31msame\u001b[0m", text: "same" };
    const blue = { rendered: "\u001b[34msame\u001b[0m", text: "same" };
    const other = { rendered: "other", text: "other" };
    const result = run("cmd | uniq -c", [red, blue, other], {
      getText: (line) => line.text,
      prefixCount: (line, count) => ({ ...line, rendered: `${count} ${line.rendered}` }),
    });
    expect(result.lines).toEqual([
      { rendered: "2 \u001b[31msame\u001b[0m", text: "same" },
      { rendered: "1 other", text: "other" },
    ]);
  });

  it("emits no lines for empty input", () => {
    expect(run("cmd | uniq -cd", [])).toEqual({ lines: [], error: null });
  });
});

describe("sort and uniq composition", () => {
  it("applies new and existing filters strictly left to right", () => {
    expect(run("cmd | grep a | sort -r | uniq | head 2", ["alpha", "beta", "alpha", "gamma"]))
      .toEqual({ lines: ["gamma", "beta"], error: null });
    expect(run("cmd | uniq -c | sort -rn | tail 2", ["apple", "apple", "berry", "citrus"]))
      .toEqual({ lines: ["1 berry", "1 citrus"], error: null });
  });

  it("retains deferred unknown-filter behavior after a new filter", () => {
    expect(run("cmd | sort | mystery", ["beta", "alpha"])).toEqual({
      lines: [],
      error: {
        type: "unknown-filter",
        stageName: "mystery",
        message: "Unknown pipeline filter: mystery",
      },
    });
  });
});

describe("deferred unknown filters", () => {
  it("retains the exact unknown stage name during validation", () => {
    const validated = compile("cmd | mystery --option");
    expect(validated.ok).toBe(true);
    expect(validated.filters).toEqual([{ type: "unknown", name: "mystery" }]);
  });

  it("reports the unknown stage when filters are applied", () => {
    expect(run("cmd | mystery", ["producer output"])).toEqual({
      lines: [],
      error: {
        type: "unknown-filter",
        stageName: "mystery",
        message: "Unknown pipeline filter: mystery",
      },
    });
  });
});

describe("cut", () => {
  it.each([
    ["singletons are ordered and deduplicated", "3,1,3", "a:c"],
    ["bounded range", "2-4", "b:c:d"],
    ["open-ended range", "3-", "c:d:e"],
    ["range from the first field", "-2", "a:b"],
    ["overlapping and absent fields", "5,2-3,2,8", "b:c:e"],
  ])("selects colon-delimited fields: %s", (_name, list, expected) => {
    expect(run(`cmd | cut -d: -f ${list}`, ["a:b:c:d:e"])).toEqual({
      lines: [expected],
      error: null,
    });
  });

  it.each([
    ["3,1,3", "a\tc"],
    ["2-4", "b\tc\td"],
    ["3-", "c\td\te"],
    ["-2", "a\tb"],
    ["5,2-3,2,8", "b\tc\te"],
  ])("uses tab as the default delimiter for LIST %s", (list, expected) => {
    expect(run(`cmd | cut -f ${list}`, ["a\tb\tc\td\te"]).lines).toEqual([expected]);
  });

  it.each([
    ["ordered singleton characters", "3,1,3", "ac"],
    ["bounded character range", "2-4", "bcd"],
    ["open-ended character range", "4-", "def"],
    ["character range from the start", "-2", "ab"],
    ["overlapping and absent characters", "2,4-5,99", "bde"],
  ])("selects 1-based characters: %s", (_name, list, expected) => {
    expect(run(`cmd | cut -c ${list}`, ["abcdef"]).lines).toEqual([expected]);
  });

  it("selects Unicode code points without splitting surrogate pairs", () => {
    expect(run("cmd | cut -c 2-3", ["A😀BC"]).lines).toEqual(["😀B"]);
  });

  it("retains an empty selected line for empty and entirely out-of-bounds selections", () => {
    expect(run("cmd | cut -c 2-3", ["", "a"]).lines).toEqual(["", ""]);
  });

  it("accepts huge decimal endpoints without rounding or expanding them", () => {
    expect(
      run(
        "cmd | cut -c 2,900719925474099312345678901234567890-",
        ["abc"]
      ).lines
    ).toEqual(["b"]);
  });

  it("supports attached and separate delimiters with identical results", () => {
    expect(run("cmd | cut -d: -f 1,3", ["a:b:c"]).lines).toEqual(["a:c"]);
    expect(run("cmd | cut -d : -f 1,3", ["a:b:c"]).lines).toEqual(["a:c"]);
  });

  it("preserves empty fields and trailing delimiters", () => {
    expect(run("cmd | cut -d : -f 1-4", ["a::c:"]).lines).toEqual(["a::c:"]);
    expect(run("cmd | cut -d : -f 2,4", ["a::c:"]).lines).toEqual([":"]);
    expect(run("cmd | cut -d : -f 9", ["a::c:"]).lines).toEqual([""]);
  });

  it.each([
    ["space", "' '", "a b c", "a c"],
    ["tab", "'\t'", "a\tb\tc", "a\tc"],
    ["pipe", "'|'", "a|b|c", "a|c"],
    ["backslash", "'\\'", "a\\b\\c", "a\\c"],
    ["emoji", "'😀'", "a😀b😀c", "a😀c"],
  ])("supports a quoted one-code-point %s delimiter", (_name, delimiter, input, expected) => {
    expect(run(`cmd | cut -d ${delimiter} -f 1,3`, [input]).lines).toEqual([expected]);
  });

  it("keeps a nondelimited line unchanged unless -s suppresses it", () => {
    const styled = { rendered: "\u001b[31mplain\u001b[0m", text: "plain" };
    const options = { getText: (line) => line.text };
    expect(run("cmd | cut -d : -f 1", [styled], options).lines[0]).toBe(styled);
    expect(run("cmd | cut -d : -f 1 -s", [styled], options).lines).toEqual([]);
    expect(run("cmd | cut -d : -f 1", [""], { getText: String }).lines).toEqual([""]);
    expect(run("cmd | cut -d : -f 1 -s", [""], { getText: String }).lines).toEqual([]);
  });

  it("selects projected visible text and emits plain strings", () => {
    const input = [
      { rendered: "\u001b[31mred\u001b[0m:blue", text: "red:blue" },
      { rendered: "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007:x", text: "link:x" },
    ];
    const options = { getText: (line) => line.text };
    expect(run("cmd | cut -d : -f 1", input, options).lines).toEqual(["red", "link"]);
    expect(run("cmd | cut -c 1-3", input, options).lines).toEqual(["red", "lin"]);
  });

  it.each([
    ["neither selection mode", "cmd | cut", "exactly one of -f or -c"],
    ["both selection modes", "cmd | cut -f 1 -c 1", "cannot be used together"],
    ["missing field LIST", "cmd | cut -f", "requires a LIST"],
    ["missing character LIST", "cmd | cut -c", "requires a LIST"],
    ["empty LIST", "cmd | cut -f ''", "LIST cannot be empty"],
    ["zero singleton", "cmd | cut -c 0", "positions must be positive"],
    ["zero in a list", "cmd | cut -f 1,0", "positions must be positive"],
    ["nonnumeric item", "cmd | cut -f abc", "invalid LIST item"],
    ["decreasing range", "cmd | cut -f 2-1", "start must not exceed end"],
    ["empty middle item", "cmd | cut -f 1,,2", "items cannot be empty"],
    ["empty trailing item", "cmd | cut -f 1,", "items cannot be empty"],
    ["range without endpoints", "cmd | cut -f -", "invalid LIST item"],
    ["range with extra separator", "cmd | cut -f 1-2-3", "invalid LIST item"],
    ["delimiter in character mode", "cmd | cut -c 1 -d :", "-d cannot be used with -c"],
    ["suppression in character mode", "cmd | cut -c 1 -s", "-s cannot be used with -c"],
    ["missing delimiter", "cmd | cut -f 1 -d", "requires a delimiter"],
    ["empty delimiter", "cmd | cut -f 1 -d ''", "exactly one character"],
    ["two-character delimiter", "cmd | cut -f 1 -d ::", "exactly one character"],
    ["unknown option", "cmd | cut -f 1 -x", "unsupported option -x"],
  ])("rejects %s during compilation", (_name, commandLine, diagnostic) => {
    const result = compile(commandLine);
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe("pre-dispatch");
    expect(result.error.stageName).toBe("cut");
    expect(result.error.message).toMatch(/^cut:/);
    expect(result.error.message).toContain(diagnostic);
  });

  it("uses the exact zero-position diagnostic required by terminal acceptance", () => {
    expect(compile("cmd | cut -c 0").error.message).toBe("cut: positions must be positive");
  });

  it("composes before and after every existing filter and repeated cut stages", () => {
    expect(run("cmd | grep : | cut -d : -f 2", ["x:beta", "skip", "x:alpha"]).lines)
      .toEqual(["beta", "alpha"]);
    expect(run("cmd | cut -d : -f 2 | grep a", ["x:beta", "x:no", "x:alpha"]).lines)
      .toEqual(["beta", "alpha"]);
    expect(run("cmd | head 2 | cut -c 2-", ["aa", "bb", "cc"]).lines).toEqual(["a", "b"]);
    expect(run("cmd | cut -c 2- | head 2", ["aa", "bb", "cc"]).lines).toEqual(["a", "b"]);
    expect(run("cmd | tail 2 | cut -c 1", ["a1", "b2", "c3"]).lines).toEqual(["b", "c"]);
    expect(run("cmd | cut -c 1 | tail 2", ["a1", "b2", "c3"]).lines).toEqual(["b", "c"]);
    expect(run("cmd | cut -c 1 | wc -l", ["aa", "bb"]).lines).toEqual(["2"]);
    expect(run("cmd | wc -l | cut -c 1", ["aa", "bb"]).lines).toEqual(["2"]);
    expect(run("cmd | sort | cut -c 1", ["ba", "ab"]).lines).toEqual(["a", "b"]);
    expect(run("cmd | cut -c 1 | sort", ["ba", "ab"]).lines).toEqual(["a", "b"]);
    expect(run("cmd | uniq | cut -c 1", ["aa", "aa", "bb"]).lines).toEqual(["a", "b"]);
    expect(run("cmd | cut -c 1 | uniq", ["aa", "ab", "bb"]).lines).toEqual(["a", "b"]);
    expect(run("cmd | cut -d : -f 2 | cut -c 2-3", ["x:abcd", "x:bcde"]).lines)
      .toEqual(["bc", "cd"]);
  });

  it("retains deferred errors for unknown filters following cut", () => {
    expect(run("cmd | cut -c 1 | mystery", ["abc"])).toEqual({
      lines: [],
      error: {
        type: "unknown-filter",
        stageName: "mystery",
        message: "Unknown pipeline filter: mystery",
      },
    });
  });
});

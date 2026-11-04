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

describe("tr", () => {
  it.each([
    ["ordinary translation", "cmd | tr ab XY", ["cab", "none"], ["cXY", "none"]],
    ["short SET2 padding", "cmd | tr abcd XY", ["abcda"], ["XYYYX"]],
    ["extra SET2 ignored", "cmd | tr ab WXYZ", ["ab"], ["WX"]],
    ["last duplicate SET1 wins", "cmd | tr aba XYZ", ["aba"], ["ZYZ"]],
    ["ASCII classes only", "cmd | tr [:lower:] [:upper:]", ["Azéz"], ["AZéZ"]],
    ["equal range", "cmd | tr a-a Z", ["aba"], ["ZbZ"]],
    ["mixed literals, range, and class", "cmd | tr 0a-c[:upper:] x", ["0aCZ"], ["xxxx"]],
    ["supplementary range", "cmd | tr 😀-😂 abc", ["😀😁😂"], ["abc"]],
    ["supplementary literals", "cmd | tr 😀😁 xy", ["a😀😁😀"], ["axyx"]],
  ])("supports %s", (_name, commandLine, input, expected) => {
    expect(run(commandLine, input)).toEqual({ lines: expected, error: null });
  });

  it("supports every escape and literal boundary hyphens", () => {
    expect(run("cmd | tr \\\\ X", ["a\\b"])).toEqual({ lines: ["aXb"], error: null });
    expect(run("cmd | tr \\-x Q", ["-x-"])).toEqual({ lines: ["QQQ"], error: null });
    expect(run("cmd | tr \\t X", ["a\tb"])).toEqual({ lines: ["aXb"], error: null });
    expect(run("cmd | tr / -", ["/home/guest"])).toEqual({ lines: ["-home-guest"], error: null });
    expect(run("cmd | tr / -x", ["/x/"])).toEqual({ lines: ["-x-"], error: null });
    expect(run("cmd | tr a -s", ["a-s"])).toEqual({ lines: ["--s"], error: null });
    expect(run("cmd | tr -d -", ["a-b-"])).toEqual({ lines: ["ab"], error: null });
    expect(run("cmd | tr -d \\-x", ["-xray"])).toEqual({ lines: ["ray"], error: null });
    expect(run("cmd | tr -d a-", ["a-b"])).toEqual({ lines: ["b"], error: null });
    expect(run("cmd | tr -d \\--", ["--a"])).toEqual({ lines: ["a"], error: null });
  });

  it("deletes digit and space classes while retaining empty line records", () => {
    expect(run("cmd | tr -d [:digit:]", ["a1b2", "123", ""])).toEqual({
      lines: ["ab", "", ""],
      error: null,
    });
    expect(run("cmd | tr -d [:space:]", ["a b\tc", "é d"])).toEqual({
      lines: ["abc", "éd"],
      error: null,
    });
    expect(run("cmd | tr -d 😀", ["😀a😀", "😁"])).toEqual({
      lines: ["a", "😁"],
      error: null,
    });
  });

  it("squeezes selected repeated characters independently on every line", () => {
    expect(run("cmd | tr -s ab", ["ababa", "aabbbaaa", "", "cc", "aa", "abbb"])).toEqual({
      lines: ["ababa", "aba", "", "cc", "a", "ab"],
      error: null,
    });
    expect(run("cmd | tr -s 😀", ["😀😀", "😀😀a😀😀", "😁😁"])).toEqual({
      lines: ["😀", "😀a😀", "😁😁"],
      error: null,
    });
  });

  it("translates before squeezing the characters in SET2", () => {
    expect(run("cmd | tr -s ab X", ["abba", "cc", "baab"])).toEqual({
      lines: ["X", "cc", "X"],
      error: null,
    });
    expect(run("cmd | tr -s 😀😁 😂", ["😀😁😁😀"])).toEqual({
      lines: ["😂"],
      error: null,
    });
  });

  it("preserves styled lines only when final visible text is unchanged", () => {
    const redA = "\u001b[31ma\u001b[0m";
    const linked = "\u001b]8;;https://example.com\u0007same\u001b]8;;\u0007";
    const options = {
      getText: (line) => line
        .replace(/\u001b\[[0-9;]*m/g, "")
        .replace(/\u001b\]8;;[^\u0007]*\u0007/g, ""),
    };
    expect(run("cmd | tr a a", [redA, linked], options)).toEqual({
      lines: [redA, linked],
      error: null,
    });
    expect(run("cmd | tr a b", [redA, linked], options)).toEqual({
      lines: ["b", "sbme"],
      error: null,
    });
    expect(run("cmd | tr -d a", [redA], options)).toEqual({ lines: [""], error: null });
    expect(run("cmd | tr -s a", [redA], options)).toEqual({ lines: [redA], error: null });
  });

  it.each([
    ["no SET", [], "SET1 is required"],
    ["no SET after -d", ["-d"], "SET1 is required"],
    ["missing SET2", ["a"], "SET2 is required"],
    ["SET2 with -d", ["-d", "a", "b"], "SET2 is not allowed"],
    ["more than two SETs", ["a", "b", "c"], "more than two SETs"],
    ["combined -d and -s", ["-d", "-s", "a"], "cannot be combined"],
    ["repeated -d", ["-d", "-d", "a"], "cannot be repeated"],
    ["repeated -s", ["-s", "-s", "a"], "cannot be repeated"],
    ["empty SET1", ["", "a"], "SET1 cannot be empty"],
    ["empty SET2", ["a", ""], "SET2 cannot be empty"],
    ["descending range", ["z-a", "x"], "descending range"],
    ["unknown class", ["[:word:]", "x"], "unknown class"],
    ["digit class in SET2", ["a", "[:digit:]"], "not allowed in SET2"],
    ["space class in SET2", ["a", "[:space:]"], "not allowed in SET2"],
    ["unknown escape", ["\\q", "x"], "unknown escape"],
    ["trailing backslash", ["a", "\\"], "trailing backslash"],
    ["unsupported -x", ["-x", "X"], "unsupported option -x"],
    ["unsupported -x after -d", ["-d", "-x"], "unsupported option -x"],
    ["unsupported -a", ["-a", "X"], "unsupported option -a"],
    ["unsupported -ds", ["-ds", "a"], "unsupported option -ds"],
    ["unsupported --", ["--", "a"], "unsupported option --"],
  ])("rejects %s before invoking commands", (_name, args, problem) => {
    env.window.commands = { cmd: vi.fn() };
    const result = pipeline.validatePipeline({
      producer: "cmd",
      stages: [{ source: `tr ${args.join(" ")}`, name: "tr", args }],
    });
    expect(result).toEqual({
      ok: false,
      error: {
        type: "pre-dispatch",
        stageName: "tr",
        message: expect.stringMatching(new RegExp(`^tr: .*${problem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)),
      },
    });
    expect(env.window.commands.cmd).not.toHaveBeenCalled();
  });

  it("composes before and after every existing filter without mutation or retained state", () => {
    const input = ["ba", "aa", "ca", "ca", "31", "2"];
    const cases = [
      ["cmd | tr a z | grep bz", ["bz"]],
      ["cmd | grep a | tr a z", ["bz", "zz", "cz", "cz"]],
      ["cmd | tr a z | head 2", ["bz", "zz"]],
      ["cmd | head 2 | tr a z", ["bz", "zz"]],
      ["cmd | tr a z | tail 2", ["31", "2"]],
      ["cmd | tail 2 | tr 123 xyz", ["zx", "y"]],
      ["cmd | tr -d 123 | wc -l", ["6"]],
      ["cmd | wc -l | tr 6 X", ["X"]],
      ["cmd | sort | tr a z", ["2", "31", "zz", "bz", "cz", "cz"]],
      ["cmd | tr a z | sort", ["2", "31", "bz", "cz", "cz", "zz"]],
      ["cmd | uniq | tr a z", ["bz", "zz", "cz", "31", "2"]],
      ["cmd | tr a z | uniq", ["bz", "zz", "cz", "31", "2"]],
    ];
    cases.forEach(([commandLine, expected]) => {
      expect(run(commandLine, input).lines).toEqual(expected);
      expect(run(commandLine, input).lines).toEqual(expected);
      expect(input).toEqual(["ba", "aa", "ca", "ca", "31", "2"]);
    });
    expect(run("cmd | tr -d a | wc -l", ["a", "ba"]).lines).toEqual(["2"]);
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

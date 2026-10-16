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

describe("reusable cut helpers", () => {
  function compileCut(args) {
    return pipeline.compileCut({ source: `cut ${args.join(" ")}`, name: "cut", args });
  }

  function expectCutError(args, message) {
    const result = compileCut(args);
    expect(result.ok).toBe(false);
    expect(result.error.type).toBe("pre-dispatch");
    expect(result.error.stageName).toBe("cut");
    expect(result.error.message).toContain(message);
    expect(result.filter).toBeUndefined();
  }

  it("accepts both option orders, leading-zero fields, and the safe-integer boundary", () => {
    expect(compileCut(["-d", ":", "-f", "1"])).toEqual({
      ok: true,
      filter: { type: "cut", name: "cut", delimiter: ":", field: 1 },
    });
    expect(compileCut(["-f", "0002", "-d", ":"])).toEqual({
      ok: true,
      filter: { type: "cut", name: "cut", delimiter: ":", field: 2 },
    });

    const maximum = compileCut(["-d", ":", "-f", "9007199254740991"]);
    expect(maximum.ok).toBe(true);
    expect(pipeline.applyCut(["alpha:beta"], maximum.filter)).toEqual({
      lines: [""],
      error: null,
    });
  });

  it("accepts every printable non-pipe ASCII delimiter literally", () => {
    for (let code = 33; code <= 126; code += 1) {
      if (code === 124) continue;
      const delimiter = String.fromCharCode(code);
      const result = compileCut(["-d", delimiter, "-f", "2"]);
      expect(result.ok, `delimiter ${JSON.stringify(delimiter)}`).toBe(true);
      expect(pipeline.applyCut([`左${delimiter}右`], result.filter)).toEqual({
        lines: ["右"],
        error: null,
      });
    }
  });

  it("rejects missing, duplicated, unknown, and extra option structure", () => {
    expectCutError([], "-d delimiter is required");
    expectCutError(["-d", ":"], "-f field is required");
    expectCutError(["-f", "2"], "-d delimiter is required");
    expectCutError(["-d"], "-d requires a value");
    expectCutError(["-d", ":", "-f"], "-f requires a value");
    expectCutError(["-d", ":", "-d", ",", "-f", "2"], "-d may be specified only once");
    expectCutError(["-f", "2", "-d", ":", "-f", "3"], "-f may be specified only once");
    expectCutError(["-d", ":", "-x", "value", "-f", "2"], "unknown option");
    expectCutError(["-d", ":", "-f", "2", "extra"], "extra argument");
  });

  it.each(["", " ", "\t", "\n", "\u001f", "\u007f", "é", "|", "::"])(
    "rejects invalid delimiter %j without returning a transform",
    (delimiter) => {
      expectCutError(["-d", delimiter, "-f", "2"], "delimiter must be one printable");
    }
  );

  it("does not add quoted-delimiter syntax", () => {
    expectCutError(["-d", "':'", "-f", "2"], "delimiter must be one printable");
    expectCutError(["-d", "\":\"", "-f", "2"], "delimiter must be one printable");
  });

  it.each([
    "0",
    "000",
    "-1",
    "+1",
    "1.5",
    "1e2",
    "0x10",
    "NaN",
    "Infinity",
    "9007199254740992",
    "999999999999999999999999999999999999999999",
    "1,2",
    "1-2",
  ])("rejects invalid field value %s", (field) => {
    expectCutError(["-d", ":", "-f", field], "field must be a positive safe base-10 integer");
  });

  it("selects literal 1-based fields and retains empty and missing fields", () => {
    const input = ["alpha:beta:gamma", ":beta", "alpha::gamma", "alpha:", "plain", ""];
    const expected = [
      ["alpha", "", "alpha", "alpha", "plain", ""],
      ["beta", "beta", "", "", "", ""],
      ["gamma", "", "gamma", "", "", ""],
      ["", "", "", "", "", ""],
    ];

    expected.forEach((lines, index) => {
      expect(pipeline.applyCut(input, { delimiter: ":", field: index + 1 })).toEqual({
        lines,
        error: null,
      });
    });
    expect(pipeline.applyCut(["left.middle", "leftXmiddle"], { delimiter: ".", field: 2 }).lines)
      .toEqual(["middle", ""]);
    expect(pipeline.applyCut(["left*middle", "leftXmiddle"], { delimiter: "*", field: 2 }).lines)
      .toEqual(["middle", ""]);
  });

  it("preserves order, line count, immutable input, and empty input", () => {
    const input = Object.freeze(["z:two", ":", "a:", "", "m:one"]);
    const empty = Object.freeze([]);
    const filter = { delimiter: ":", field: 2 };

    expect(pipeline.applyCut(input, filter)).toEqual({
      lines: ["two", "", "", "", "one"],
      error: null,
    });
    expect(pipeline.applyCut(input, filter)).toEqual({
      lines: ["two", "", "", "", "one"],
      error: null,
    });
    expect(input).toEqual(["z:two", ":", "a:", "", "m:one"]);
    expect(pipeline.applyCut(empty, filter)).toEqual({ lines: [], error: null });
    expect(empty).toEqual([]);
  });

  it("removes CSI, OSC hyperlink, and short escape sequences before splitting", () => {
    const input = [
      "\u001b[31ma:beta\u001b[0m",
      "\u001b]8;;https://example.test/a:b\u0007a:beta\u001b]8;;\u0007",
      "\u001b]8;;https://example.test/a:b\u001b\\a:beta\u001b]8;;\u001b\\",
      "\u001b(Ba:beta",
      "a:%help%",
    ];
    const result = pipeline.applyCut(input, { delimiter: ":", field: 2 });

    expect(result).toEqual({
      lines: ["beta", "beta", "beta", "beta", "%help%"],
      error: null,
    });
    result.lines.forEach((line) => expect(line).not.toContain("\u001b"));
  });

  it("registers cut through ordinary stage compilation and composition", () => {
    const validated = compile("echo alpha:beta | cut -d : -f 2");
    expect(validated.ok).toBe(true);
    expect(validated.filters).toEqual([
      { type: "cut", name: "cut", delimiter: ":", field: 2 },
    ]);
    expect(pipeline.applyPipeline(["alpha:beta"], validated.filters)).toEqual({
      lines: ["beta"],
      error: null,
    });
    expect(
      run(
        "cmd | cut -d : -f 2 | sort | uniq",
        ["z:beta", "a:beta", "q:alpha"]
      )
    ).toEqual({ lines: ["alpha", "beta"], error: null });
    expect(
      run(
        "cmd | grep beta | cut -d : -f 2 | sort | uniq | wc -l",
        ["z:beta", "a:beta", "q:alpha"]
      )
    ).toEqual({ lines: ["1"], error: null });
    expect(run("cmd | cut -d : -f 2 | cut -d . -f 2", ["a:beta.two"]))
      .toEqual({ lines: ["two"], error: null });
  });
});

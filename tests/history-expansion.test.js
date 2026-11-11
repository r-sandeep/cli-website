import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

describe("history expansion grammar", () => {
  let env;
  let expandHistory;

  beforeEach(() => {
    env = createBrowserEnv();
    env.loadScript("js/terminal-ext.js");
    expandHistory = env.exportValues(["_expandHistory"])._expandHistory;
  });

  afterEach(() => env.cleanup());

  const expectLine = (input, history, status, line) => {
    const snapshot = [...history];
    expect(expandHistory(input, history)).toMatchObject({ status, line });
    expect(history).toEqual(snapshot);
  };

  const expectError = (input, history, error) => {
    const snapshot = [...history];
    const result = expandHistory(input, history);
    expect(result).toEqual({ status: "error", error });
    expect(result).not.toHaveProperty("line");
    expect(history).toEqual(snapshot);
  };

  it("resolves previous, absolute, relative, and newest prefix events", () => {
    const history = ["echo first", "say other", "echo last"];
    const cases = [
      ["!!", "echo last"],
      ["!1000", "echo first"],
      ["!1002", "echo last"],
      ["!0001000", "echo first"],
      ["!-1", "echo last"],
      ["!-2", "say other"],
      ["!-0002", "say other"],
      ["!echo", "echo last"],
    ];

    for (const [input, expected] of cases) {
      expectLine(input, history, "expanded", expected);
    }
  });

  it("expands every original event in place without swallowing suffixes", () => {
    const history = ["echo a"];
    const cases = [
      ["echo !! !!", "echo echo a echo a"],
      ["x!!y", "xecho ay"],
      ['echo "!!"', 'echo "echo a"'],
      ["!!x", "echo ax"],
      ["!1000x", "echo ax"],
      ["!!!!", "echo aecho a"],
    ];

    for (const [input, expected] of cases) {
      expectLine(input, history, "expanded", expected);
    }

    const prefixHistory = [
      "run.alpha",
      "run-alpha",
      "run_alpha",
      "run=alpha",
      "run$alpha",
      "run^alpha",
    ];
    const terminators = [" ", "\t", "'", '"', "!", "|", ">", "<", ";", "&"];
    for (const terminator of terminators) {
      const input = `!run^alpha${terminator}`;
      expectLine(input, prefixHistory, "expanded", `run^alpha${terminator}`);
    }
    expectLine("!run.alpha", prefixHistory, "expanded", "run.alpha");
    expectLine("!run-alpha", prefixHistory, "expanded", "run-alpha");
    expectLine("!run_alpha", prefixHistory, "expanded", "run_alpha");
    expectLine("!run=alpha", prefixHistory, "expanded", "run=alpha");
    expectLine("!run$alpha", prefixHistory, "expanded", "run$alpha");
  });

  it("preserves protected and unrecognized bangs byte for byte", () => {
    const history = ["echo previous"];
    const unchanged = [
      "echo '!!'",
      "echo \\!",
      'echo "\\!"',
      "echo hi!",
      "echo a ! b",
      "echo !=",
      "echo !$",
      "echo !-0",
      "echo !-00",
      "echo !éclair",
      "  echo \\!  ",
    ];

    for (const input of unchanged) {
      expectLine(input, history, "unchanged", input);
    }
    expectLine(
      "echo '!!' !! '!1000'",
      history,
      "expanded",
      "echo '!!' echo previous '!1000'"
    );
    expectLine(
      `echo "'!!'"`,
      history,
      "expanded",
      `echo "'echo previous'"`
    );

    const escapedDoubleQuote = String.raw`echo "\"'" !!`;
    expectLine(
      escapedDoubleQuote,
      history,
      "unchanged",
      escapedDoubleQuote
    );
  });

  it("keeps apostrophe spans protected regardless of preceding backslashes", () => {
    const history = ["echo seed"];

    for (const count of [1, 2, 3]) {
      const input = `echo ${"\\".repeat(count)}'!!'`;
      expectLine(input, history, "unchanged", input);
      expect(expandHistory(input, history)).toEqual(expandHistory(input, history));
    }

    const escapedAroundSpan = String.raw`echo \'!!\'`;
    expectLine(escapedAroundSpan, history, "unchanged", escapedAroundSpan);
    expectLine(
      `${escapedAroundSpan} !!`,
      history,
      "expanded",
      `${escapedAroundSpan} echo seed`
    );
  });

  it("performs quick substitution literally on only the first occurrence", () => {
    const cases = [
      ["^a^b", ["echo a a"], "echo b a"],
      ["^a^b^", ["echo a a"], "echo b a"],
      ["^a^b^^", ["echo a a"], "echo b^ a"],
      ["^a^", ["echo a a"], "echo  a"],
      ["^.^$&", ["echo a.b"], "echo a$&b"],
      ["^a^b^c", ["echo a"], "echo b^c"],
      ["^a^!!", ["echo a"], "echo !!"],
    ];

    for (const [input, history, expected] of cases) {
      expectLine(input, history, "expanded", expected);
    }
    expectLine("^", ["echo a"], "unchanged", "^");
    expectLine(" ^a^b", ["echo a"], "unchanged", " ^a^b");
    expectLine("^a^a", ["^a^a"], "expanded", "^a^a");
  });

  it("reports each independent quick substitution failure", () => {
    expectError("^a^b", [], "substitution failed");
    expectError("^^b", ["echo a"], "substitution failed");
    expectError(
      "^missing^b",
      ["missing in an older entry", "echo newest"],
      "substitution failed"
    );
  });

  it("reports the complete first missing event without a partial line", () => {
    expectError("!!", [], "!!: event not found");
    expectError("!999", ["echo a"], "!999: event not found");
    expectError("!1001", ["echo a"], "!1001: event not found");
    expectError(
      "!999999999999999999999999999999999999",
      ["echo a"],
      "!999999999999999999999999999999999999: event not found"
    );
    expectError("!-2", ["echo a"], "!-2: event not found");
    expectError("!Missing", ["echo a"], "!Missing: event not found");
    expectError(
      "echo !! !9999 !Missing",
      ["echo a"],
      "!9999: event not found"
    );
    expectError(
      "echo !Missing !9999",
      ["echo a"],
      "!Missing: event not found"
    );
  });

  it("treats inserted history and substitution text as opaque", () => {
    const history = ['echo "!!" !1000'];
    expectLine("!! !!", history, "expanded", `${history[0]} ${history[0]}`);
    expectLine("!! !1000", history, "expanded", `${history[0]} ${history[0]}`);

    const quoteHistory = ["'", "echo last"];
    expectLine("!1000 !!", quoteHistory, "expanded", "' echo last");

    const substitutionHistory = ["echo marker"];
    expectLine("^marker^!!", substitutionHistory, "expanded", "echo !!");
    expect(expandHistory("!!", history)).toEqual(expandHistory("!!", history));
  });
});
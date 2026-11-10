import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadExpandHistory({ bigIntAvailable = true } = {}) {
  env = createBrowserEnv();
  if (!bigIntAvailable) env.window.BigInt = undefined;
  env.loadScript("js/terminal-ext.js");
  return env.exportValues(["_expandHistory"])._expandHistory;
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("history expansion", () => {
  it.each([
    ["!!", "echo last"],
    ["!-1", "echo last"],
    ["!-2", "Echo cap"],
    ["!-5", "echo zero"],
    ["!1000", "echo zero"],
    ["!1003", "Echo cap"],
    ["!1003x", "Echo capx"],
    ["!1004", "echo last"],
    ["!01003", "Echo cap"],
    ["!echo", "echo last"],
    ["!Echo", "Echo cap"],
    ["!!x", "echo lastx"],
  ])("resolves %s with exact ordering and boundaries", (line, expected) => {
    const expand = loadExpandHistory();
    const history = ["echo zero", "echo a", "say b", "Echo cap", "echo last"];

    expect(expand(line, history)).toEqual({
      ok: true,
      line: expected,
      expanded: true,
    });
    expect(history).toEqual(["echo zero", "echo a", "say b", "Echo cap", "echo last"]);
  });

  it.each([
    ["!999", "!999: event not found"],
    ["!1005", "!1005: event not found"],
    ["!10030x", "!10030: event not found"],
    ["!999999999999999999999999999999", "!999999999999999999999999999999: event not found"],
    ["!-6", "!-6: event not found"],
    ["!-999999999999999999999999999999", "!-999999999999999999999999999999: event not found"],
    ["!missing", "!missing: event not found"],
  ])("rejects the complete out-of-range event %s", (line, message) => {
    const expand = loadExpandHistory();
    const history = ["echo zero", "echo a", "say b", "Echo cap", "echo last"];

    expect(expand(line, history)).toEqual({ ok: false, message });
    expect(history).toEqual(["echo zero", "echo a", "say b", "Echo cap", "echo last"]);
  });

  it.each([
    ["echo !! !!", "echo echo a echo a"],
    ["echo x!!y", "echo xecho ay"],
    ['echo "!!"', 'echo "echo a"'],
    ["!echo suffix", "echo a suffix"],
    ["!echo'suffix'", "echo a'suffix'"],
    ['!echo"suffix"', 'echo a"suffix"'],
    ["!echo!!", "echo aecho a"],
    ["!echo|suffix", "echo a|suffix"],
    ["!echo>suffix", "echo a>suffix"],
    ["!echo<suffix", "echo a<suffix"],
    ["!echo;suffix", "echo a;suffix"],
    ["!echo&suffix", "echo a&suffix"],
  ])("expands submitted designators once in %s", (line, expected) => {
    const expand = loadExpandHistory();

    expect(expand(line, ["echo a"])).toEqual({
      ok: true,
      line: expected,
      expanded: true,
    });
  });

  it.each([
    "echo '!!'",
    "echo \\!",
    "echo \\!!",
    "echo \\!1000",
    "echo \\!-1",
    "echo \\!echo",
    "echo hi!",
    "echo a ! b",
    "echo !=",
    "echo !$",
    "!-0",
    "!-",
    "!_",
    "echo ordinary",
    "^missing separator",
  ])("leaves literal input byte-for-byte unchanged: %s", (line) => {
    const expand = loadExpandHistory();

    expect(expand(line, ["echo visible"])).toEqual({
      ok: true,
      line,
      expanded: false,
    });
  });

  it("includes ordinary punctuation and digits in a prefix until a delimiter", () => {
    const expand = loadExpandHistory();

    expect(expand("!echo.v2", ["echo old", "echo.v2 selected"])).toEqual({
      ok: true,
      line: "echo.v2 selected",
      expanded: true,
    });
  });

  it("expands bangs in double quotes but not single quotes nested in them", () => {
    const expand = loadExpandHistory();

    expect(expand(`echo "'!!'" '"!!"'`, ["echo a"])).toEqual({
      ok: true,
      line: `echo "'echo a'" '"!!"'`,
      expanded: true,
    });
  });

  it.each([
    ["^a^b", "echo b a"],
    ["^a^", "echo  a"],
    ["^a^b^", "echo b a"],
    ["^a^b^^", "echo b^ a"],
    ["^.^$&", "echo $& a.a"],
  ])("performs first-occurrence literal quick substitution for %s", (line, expected) => {
    const expand = loadExpandHistory();
    const previous = line === "^.^$&" ? "echo . a.a" : "echo a a";

    expect(expand(line, [previous])).toEqual({
      ok: true,
      line: expected,
      expanded: true,
    });
  });

  it("recognizes quick substitution before trimming", () => {
    const expand = loadExpandHistory();

    expect(expand(" ^a^b", ["echo a"])).toEqual({
      ok: true,
      line: " ^a^b",
      expanded: false,
    });
  });

  it.each([
    ["^a^b", []],
    ["^^b", ["echo a"]],
    ["^missing^b", ["echo a"]],
  ])("returns the exact quick-substitution failure for %s", (line, history) => {
    const expand = loadExpandHistory();
    const snapshot = [...history];

    expect(expand(line, history)).toEqual({
      ok: false,
      message: "substitution failed",
    });
    expect(history).toEqual(snapshot);
  });

  it.each(["!!", "!1000", "!-1", "!echo"])(
    "reports an empty-history event failure for %s",
    (event) => {
      const expand = loadExpandHistory();

      expect(expand(event, [])).toEqual({
        ok: false,
        message: `${event}: event not found`,
      });
    }
  );

  it("returns the first failing typed event without exposing partial output", () => {
    const expand = loadExpandHistory();
    const history = ["echo a"];

    expect(expand("!! !missing !1009", history)).toEqual({
      ok: false,
      message: "!missing: event not found",
    });
    expect(history).toEqual(["echo a"]);
  });

  it("does not rescan text inserted from history", () => {
    const expand = loadExpandHistory();

    expect(expand("!!", ["echo ordinary", "echo !!"])).toEqual({
      ok: true,
      line: "echo !!",
      expanded: true,
    });
  });

  it("does not rescan bangs inserted by quick substitution", () => {
    const expand = loadExpandHistory();

    expect(expand("^ordinary^!!", ["echo ordinary"])).toEqual({
      ok: true,
      line: "echo !!",
      expanded: true,
    });
  });

  it.each([
    ["!1000", { ok: true, line: "echo zero", expanded: true }],
    ["!1001tail", { ok: true, line: "echo onetail", expanded: true }],
    ["!0001000", { ok: true, line: "echo zero", expanded: true }],
    [`!${"0".repeat(300)}1001x`, { ok: true, line: "echo onex", expanded: true }],
    ["!999", { ok: false, message: "!999: event not found" }],
    ["!1002", { ok: false, message: "!1002: event not found" }],
    [`!${"9".repeat(300)}tail`, { ok: false, message: `!${"9".repeat(300)}: event not found` }],
    ["!-1", { ok: true, line: "echo one", expanded: true }],
    ["!-2tail", { ok: true, line: "echo zerotail", expanded: true }],
    ["!-0001", { ok: true, line: "echo one", expanded: true }],
    [`!-${"0".repeat(300)}2x`, { ok: true, line: "echo zerox", expanded: true }],
    ["!-3", { ok: false, message: "!-3: event not found" }],
    [`!-${"9".repeat(300)}tail`, { ok: false, message: `!-${"9".repeat(300)}: event not found` }],
    ["!-0", { ok: true, line: "!-0", expanded: false }],
    ["!-0000", { ok: true, line: "!-0000", expanded: false }],
  ])("bounds complete decimal token %s without lossy conversion", (line, expected) => {
    const expand = loadExpandHistory();

    expect(expand(line, ["echo zero", "echo one"])).toEqual(expected);
  });

  it("executes the actual scanner when BigInt is unavailable", () => {
    const expand = loadExpandHistory({ bigIntAvailable: false });
    const huge = `!${"9".repeat(300)}`;

    expect(expand("!0001001", ["echo zero", "echo one"])).toEqual({
      ok: true,
      line: "echo one",
      expanded: true,
    });
    expect(expand("!-0002x", ["echo zero", "echo one"])).toEqual({
      ok: true,
      line: "echo zerox",
      expanded: true,
    });
    expect(expand(huge, ["echo zero", "echo one"])).toEqual({
      ok: false,
      message: `${huge}: event not found`,
    });
    expect(expand("!-0", ["echo zero", "echo one"])).toEqual({
      ok: true,
      line: "!-0",
      expanded: false,
    });
    expect(expand("echo ordinary", ["echo zero", "echo one"])).toEqual({
      ok: true,
      line: "echo ordinary",
      expanded: false,
    });
  });
});

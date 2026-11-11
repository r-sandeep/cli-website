import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

describe("history expansion grammar", () => {
  let env;
  let expand;

  beforeEach(() => {
    env = createBrowserEnv();
    env.loadScript("js/terminal-ext.js");
    expand = env.exportValues(["_expandHistoryLine"])._expandHistoryLine;
  });

  afterEach(() => {
    env.cleanup();
  });

  it("resolves previous, absolute, relative and latest-prefix events", () => {
    const history = ["echo a", "ping", "echo b", "pwd"];

    expect(expand("!!", history)).toEqual({
      ok: true,
      line: "pwd",
      expanded: true,
    });
    expect(expand("!1000", history)).toEqual({
      ok: true,
      line: "echo a",
      expanded: true,
    });
    expect(expand("!1003", history)).toEqual({
      ok: true,
      line: "pwd",
      expanded: true,
    });
    expect(expand("!-1", history).line).toBe("pwd");
    expect(expand("!-2", history).line).toBe("echo b");
    expect(expand("!echo", history).line).toBe("echo b");
    expect(expand("!01000", history).line).toBe("echo a");
    expect(expand("!1003suffix", history).line).toBe("pwdsuffix");
    expect(expand("!10030", history)).toEqual({
      ok: false,
      error: "!10030: event not found",
    });
  });

  it("expands every source occurrence inside words and double quotes", () => {
    const history = ["echo a"];

    expect(expand("echo !! !!", history).line).toBe("echo echo a echo a");
    expect(expand("pre!!post", history).line).toBe("preecho apost");
    expect(expand('echo "!!"', history).line).toBe('echo "echo a"');
    expect(expand("!!x", history).line).toBe("echo ax");
    expect(expand("!1000!!", history).line).toBe("echo aecho a");
  });

  it.each([
    ["space", "!echo rest", "echo old rest"],
    ["single quote", "!echo'rest'", "echo old'rest'"],
    ["double quote", '!echo"rest"', 'echo old"rest"'],
    ["bang", "!echo!!", "echo oldpwd"],
    ["pipe", "!echo|wc", "echo old|wc"],
    ["output redirect", "!echo>out", "echo old>out"],
    ["input redirect", "!echo<in", "echo old<in"],
    ["semicolon", "!echo;pwd", "echo old;pwd"],
    ["ampersand", "!echo&pwd", "echo old&pwd"],
    ["end", "!echo", "echo old"],
  ])("stops prefix lookup at %s", (_label, source, expected) => {
    expect(expand(source, ["echo old", "pwd"]).line).toBe(expected);
  });

  it("retains single-quoted, escaped and unrecognized bangs byte for byte", () => {
    const history = ["echo previous"];
    const literals = [
      "echo '!!'",
      "echo \\!",
      "echo hi!",
      "echo a ! b",
      "echo !=",
      "echo !$",
      "echo !éclair",
      "echo !-",
      "echo !-0",
      "echo '\"!!\"'",
    ];

    for (const source of literals) {
      expect(expand(source, history)).toEqual({
        ok: true,
        line: source,
        expanded: false,
      });
    }

    expect(expand('echo "\'!!\'" !!', history).line).toBe(
      'echo "\'echo previous\'" echo previous'
    );
  });

  it("performs literal first-occurrence quick substitutions", () => {
    const history = ["echo old old"];

    expect(expand("^old^new", history)).toEqual({
      ok: true,
      line: "echo new old",
      expanded: true,
    });
    expect(expand("^old^new^", history).line).toBe("echo new old");
    expect(expand("^old^new^^", history).line).toBe("echo new^ old");
    expect(expand("^old^", history).line).toBe("echo  old");
    expect(expand("^old^new^again", history).line).toBe("echo new^again old");
    expect(expand(" ^old^new", history)).toEqual({
      ok: true,
      line: " ^old^new",
      expanded: false,
    });
    expect(expand("^old", history)).toEqual({
      ok: true,
      line: "^old",
      expanded: false,
    });

    expect(expand("^.^$&", ["echo . ."]).line).toBe("echo $& .");
    expect(expand("^(a)^$1", ["echo (a) (a)"]).line).toBe("echo $1 (a)");
  });

  it("returns the exact first unavailable event without a partial result", () => {
    expect(expand("!!", [])).toEqual({
      ok: false,
      error: "!!: event not found",
    });

    const history = ["echo a", "ping"];
    for (const event of ["!999", "!1002", "!-3", "!missing"]) {
      expect(expand(event, history)).toEqual({
        ok: false,
        error: `${event}: event not found`,
      });
    }
    const huge = "!999999999999999999999999999999999999999";
    expect(expand(huge, history)).toEqual({
      ok: false,
      error: `${huge}: event not found`,
    });
    const hugeRelative = "!-999999999999999999999999999999999999999";
    expect(expand(hugeRelative, history)).toEqual({
      ok: false,
      error: `${hugeRelative}: event not found`,
    });
    expect(expand("!! !missing !999", history)).toEqual({
      ok: false,
      error: "!missing: event not found",
    });
    expect(expand("!1000", history).line).toBe("echo a");
  });

  it("reports each independent quick-substitution failure", () => {
    expect(expand("^a^b", [])).toEqual({
      ok: false,
      error: "substitution failed",
    });
    expect(expand("^^b", ["echo a"])).toEqual({
      ok: false,
      error: "substitution failed",
    });
    expect(expand("^missing^b", ["echo a"])).toEqual({
      ok: false,
      error: "substitution failed",
    });
    expect(expand("^a^b", ["echo a"]).line).toBe("echo b");
  });

  it("treats inserted history text opaquely and never mutates its snapshot", () => {
    const recursiveLooking = Object.freeze(["echo !missing"]);
    const recursiveBefore = [...recursiveLooking];

    expect(expand("!1000", recursiveLooking)).toEqual({
      ok: true,
      line: "echo !missing",
      expanded: true,
    });
    expect(expand("!1000", recursiveLooking)).toEqual({
      ok: true,
      line: "echo !missing",
      expanded: true,
    });
    expect(recursiveLooking).toEqual(recursiveBefore);

    const quoteLooking = Object.freeze(["echo '"]);
    expect(expand("!! !!", quoteLooking).line).toBe("echo ' echo '");
    expect(expand("!! !!", quoteLooking).line).toBe("echo ' echo '");
    expect(quoteLooking).toEqual(["echo '"]);
  });
});
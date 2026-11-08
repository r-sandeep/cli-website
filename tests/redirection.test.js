import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadParser() {
  env = createBrowserEnv();
  env.loadScripts(["js/terminal-ext.js"]);
  return env.exportValues(["_parseRedirection"])._parseRedirection;
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("redirection syntax", () => {
  it("recognizes only the first unquoted operator and preserves command quoting", () => {
    const parse = loadParser();

    expect(parse("echo hi>notes.txt")).toEqual({
      hasRedirection: true,
      command: "echo hi",
      operator: ">",
      filename: "notes.txt",
      append: false,
      error: null,
    });
    expect(parse("  echo hi   >>   notes.txt  ")).toEqual({
      hasRedirection: true,
      command: "echo hi",
      operator: ">>",
      filename: "notes.txt",
      append: true,
      error: null,
    });
    expect(parse('echo "a > b"')).toEqual({
      hasRedirection: false,
      command: 'echo "a > b"',
      operator: null,
      filename: null,
      append: false,
      error: null,
    });
    expect(parse("echo 'a > b'")).toEqual({
      hasRedirection: false,
      command: "echo 'a > b'",
      operator: null,
      filename: null,
      append: false,
      error: null,
    });
    expect(parse(`echo "a ' > b" 'c " > d' > mixed_1`)).toEqual({
      hasRedirection: true,
      command: `echo "a ' > b" 'c " > d'`,
      operator: ">",
      filename: "mixed_1",
      append: false,
      error: null,
    });
  });

  it("rejects commands whose first parsed command token is semantically empty", () => {
    const parse = loadParser();

    for (const line of [
      '"" > emptycmd',
      "'' >> emptycmd",
      '""\'\' > emptycmd',
      '"" later > emptycmd',
      "''\"\" later >> emptycmd",
    ]) {
      expect(parse(line)).toMatchObject({
        hasRedirection: true,
        filename: null,
        error: "redirect: command required",
      });
    }

    expect(parse('"echo" ok > valid')).toEqual({
      hasRedirection: true,
      command: '"echo" ok',
      operator: ">",
      filename: "valid",
      append: false,
      error: null,
    });
  });

  it("accepts the exact filename boundaries", () => {
    const parse = loadParser();
    const longest = `a${"b".repeat(63)}`;

    expect(parse("echo ok>x").filename).toBe("x");
    expect(parse(`echo ok>${longest}`)).toEqual({
      hasRedirection: true,
      command: "echo ok",
      operator: ">",
      filename: longest,
      append: false,
      error: null,
    });
    expect(parse("echo ok>a.b-c_d9").filename).toBe("a.b-c_d9");
  });

  it.each([
    ["missing target", "echo ok >", "redirect: file name required"],
    ["two names", "echo ok > one two", "redirect: one file name required"],
    ["second operator", "echo ok > one > two", "redirect: unexpected second >"],
    ["triple operator", "echo ok >>> one", "redirect: unexpected second >"],
    ["single-quoted target", "echo ok > 'one'", "redirect: quoted file names are not supported"],
    ["single-quoted multiword target", "echo ok >> 'one two'", "redirect: quoted file names are not supported"],
    ["double-quoted target", 'echo ok > "one"', "redirect: quoted file names are not supported"],
    ["double-quoted multiword target", 'echo ok >> "one two"', "redirect: quoted file names are not supported"],
    ["leading dot", "echo ok > .one", "redirect: invalid file name"],
    ["leading dash", "echo ok > -one", "redirect: invalid file name"],
    ["slash", "echo ok > a/b", "redirect: invalid file name"],
    ["Unicode", "echo ok > café", "redirect: invalid file name"],
    ["punctuation", "echo ok > one!", "redirect: invalid file name"],
    ["65 characters", `echo ok > a${"b".repeat(64)}`, "redirect: invalid file name"],
    ["missing command", "> one", "redirect: command required"],
  ])("rejects %s with its own complete diagnostic", (_label, line, error) => {
    const parse = loadParser();
    const result = parse(line);

    expect(result).toEqual({
      hasRedirection: true,
      command: result.command,
      operator: result.operator,
      filename: null,
      append: result.append,
      error,
    });
    expect(result.error.startsWith("redirect:")).toBe(true);
  });
});
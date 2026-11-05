import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadParser() {
  env = createBrowserEnv();
  env.loadScript("js/terminal-ext.js");
  return env.exportValues(["_parseRedirection"])._parseRedirection;
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("redirection parser", () => {
  it.each([
    ["echo hi>notes.txt", "echo hi", "notes.txt", false],
    ["echo hi >> notes.txt", "echo hi", "notes.txt", true],
    ["  echo hi  >  notes.txt  ", "echo hi", "notes.txt", false],
    ['echo "a > b">notes.txt', 'echo "a > b"', "notes.txt", false],
    ["echo 'a >> b'>>notes.txt", "echo 'a >> b'", "notes.txt", true],
  ])(
    "parses the first unquoted operator in %s",
    (line, command, fileName, append) => {
      const parseRedirection = loadParser();

      expect(parseRedirection(line)).toEqual({
        command,
        fileName,
        append,
        error: null,
      });
    }
  );

  it.each([
    'echo "a > b"',
    "echo 'a >> b'",
    "ll --all",
    "echo $HOME",
    "",
  ])("leaves a line without an unquoted operator untouched: %s", (line) => {
    const parseRedirection = loadParser();

    expect(parseRedirection(line)).toBeNull();
  });

  it.each([
    ["echo hi >", "redirect: missing file name"],
    [">notes", "redirect: missing command"],
    ["echo hi > notes extra", "redirect: expected exactly one file name"],
    ["echo hi > notes > extra", "redirect: more than one redirection operator"],
    ['echo hi > "notes"', "redirect: quoted file names are not supported"],
    ["echo hi > 'notes'", "redirect: quoted file names are not supported"],
    ["echo hi > .a", "redirect: invalid file name .a"],
    ["echo hi > -a", "redirect: invalid file name -a"],
    ["echo hi > a/b", "redirect: invalid file name a/b"],
    ["echo hi > a$", "redirect: invalid file name a$"],
    ["echo hi > café", "redirect: invalid file name café"],
    [`echo hi > ${"a".repeat(65)}`, `redirect: invalid file name ${"a".repeat(65)}`],
  ])("returns one problem-specific diagnostic for %s", (line, error) => {
    const parseRedirection = loadParser();

    expect(parseRedirection(line)).toEqual({ error });
  });

  it.each([
    "a",
    "a".repeat(64),
    "A0_b.c-d",
    "__proto__",
  ])("accepts a filename at the permitted boundary: %s", (fileName) => {
    const parseRedirection = loadParser();

    expect(parseRedirection(`echo ok>${fileName}`)).toEqual({
      command: "echo ok",
      fileName,
      append: false,
      error: null,
    });
  });
});
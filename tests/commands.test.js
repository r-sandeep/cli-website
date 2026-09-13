import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const commandSource = readFileSync("config/commands.js", "utf8");
const jobsContext = vm.createContext({ module: { exports: {} } });
vm.runInContext(`${readFileSync("config/jobs.js", "utf8")}\nthis.productionJobs = jobs;`, jobsContext);
const productionJobs = jobsContext.productionJobs;
const testJobs = { ...productionJobs, 2: ["Platform Engineer"] };

function loadApply({ inputs = [], jobs = testJobs, response } = {}) {
  const term = {
    locked: false,
    stylePrint: vi.fn(),
    prompt: vi.fn(),
    clearCurrentLine: vi.fn(),
    collectInput: vi.fn(),
  };
  inputs.forEach((input) => term.collectInput.mockResolvedValueOnce(input));
  const fetch = vi.fn().mockResolvedValue(
    response || { ok: true, json: vi.fn().mockResolvedValue({}) }
  );
  const context = vm.createContext({
    term,
    jobs,
    firm: { blurb: "", email: "hello@example.com" },
    team: {},
    help: {},
    portfolio: {},
    colorText: (text) => text,
    fetch,
  });
  vm.runInContext(commandSource, context);
  return { apply: vm.runInContext("commands.apply", context), term, fetch };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for apply to settle");
}

describe("apply", () => {
  it("submits each selected registry title for jobs 1 and 2 without a live request", async () => {
    for (const [id, jobs] of [["1", productionJobs], ["2", testJobs]]) {
      const { apply, fetch } = loadApply({ jobs, inputs: ["Ada", "ada@example.com", "", "", ""] });
      expect(apply([id])).toBe(1);
      await waitFor(() => fetch.mock.calls.length === 1);
      expect(fetch).toHaveBeenCalledWith(
        "/.netlify/functions/submit-application",
        expect.objectContaining({ body: expect.stringContaining(`"position":"${jobs[id][0]}"`) })
      );
    }
  });

  it("preserves missing and unknown job errors without collecting or fetching", () => {
    const missing = loadApply();
    missing.apply([]);
    expect(missing.term.stylePrint).toHaveBeenCalledWith("Please provide a job id. Use %jobs% to list all current jobs.");
    expect(missing.term.collectInput).not.toHaveBeenCalled();
    expect(missing.fetch).not.toHaveBeenCalled();

    const unknown = loadApply();
    unknown.apply(["99"]);
    expect(unknown.term.stylePrint).toHaveBeenCalledWith("Job id 99 not found. Use %jobs% to list all current jobs.");
    expect(unknown.term.collectInput).not.toHaveBeenCalled();
    expect(unknown.fetch).not.toHaveBeenCalled();
  });

  it("rejects prototype-inherited ids without collecting or fetching", () => {
    const unknown = loadApply();
    unknown.apply(["toString"]);
    expect(unknown.term.stylePrint).toHaveBeenCalledWith("Job id toString not found. Use %jobs% to list all current jobs.");
    expect(unknown.term.collectInput).not.toHaveBeenCalled();
    expect(unknown.fetch).not.toHaveBeenCalled();
  });

  it("cancels without fetching and restores the terminal", async () => {
    const { apply, term, fetch } = loadApply({ inputs: [null] });
    expect(apply(["1"])).toBe(1);
    await waitFor(() => term.prompt.mock.calls.length === 1);
    expect(term.stylePrint).toHaveBeenCalledWith("\r\nApplication cancelled.");
    expect(term.prompt).toHaveBeenCalled();
    expect(term.clearCurrentLine).toHaveBeenCalledWith(true);
    expect(term.locked).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores the terminal after successful and failed server submissions", async () => {
    for (const [response, output] of [
      [
        { ok: true, json: vi.fn().mockResolvedValue({}) },
        "\r\n✓ Application submitted successfully!",
      ],
      [
        { ok: false, json: vi.fn().mockResolvedValue({ error: "Server failed" }) },
        "\r\n✗ Error submitting application: Server failed",
      ],
    ]) {
      const { apply, term, fetch } = loadApply({ inputs: ["Ada", "ada@example.com", "", "", ""], response });
      expect(apply(["1"])).toBe(1);
      await waitFor(() => fetch.mock.calls.length === 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(term.stylePrint).toHaveBeenCalledWith(output);
      expect(term.prompt).toHaveBeenCalled();
      expect(term.clearCurrentLine).toHaveBeenCalledWith(true);
      expect(term.locked).toBe(false);
    }
  });
});

// Loads the full command set with a fake terminal. `cd` is the one command with
// real branching logic — a switch over ~, .., /home, /bin and team member names
// — and it drives term.cwd, which the prompt renders on every keystroke.
function loadCommands({ cwd = "~", user = "guest", team = { avidan: {} } } = {}) {
  const aliases = new Map();
  const term = {
    cwd,
    user,
    stylePrint: vi.fn(),
    writeln: vi.fn(),
    printArt: vi.fn(),
    openURL: vi.fn(),
    displayURL: vi.fn(),
    cols: 100,
    defineAlias: vi.fn((name, value) => {
      aliases.set(name, value);
      return true;
    }),
    getAlias: vi.fn((name) =>
      aliases.has(name) ? aliases.get(name) : undefined
    ),
    getAliases: vi.fn(() =>
      Array.from(aliases.entries()).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0
      )
    ),
    removeAlias: vi.fn((name) => aliases.delete(name)),
  };
  const context = vm.createContext({
    term,
    jobs: productionJobs,
    firm: { blurb: "", email: "hello@example.com" },
    team,
    help: {},
    portfolio: {},
    colorText: (text) => text,
    window: {},
  });
  vm.runInContext(commandSource, context);
  const commands = vm.runInContext("commands", context);
  // cd recurses through term.command for the paths that resolve via another cd.
  term.command = (line) => {
    const [name, ...args] = line.split(" ");
    return commands[name](args);
  };
  return { commands, term };
}

describe("alias management", () => {
  it("defines, replaces, lists, and queries exact-case aliases", () => {
    const { commands, term } = loadCommands();

    commands.alias(["zebra=echo", "last"]);
    expect(term.defineAlias).toHaveBeenLastCalledWith("zebra", "echo last");
    commands.alias(["constructor=echo", "constructor"]);
    expect(term.defineAlias).toHaveBeenLastCalledWith(
      "constructor",
      "echo constructor"
    );
    commands.alias(["__proto__=echo", "proto"]);
    expect(term.defineAlias).toHaveBeenLastCalledWith("__proto__", "echo proto");
    commands.alias(["zebra=echo", "replaced"]);
    expect(term.defineAlias).toHaveBeenLastCalledWith("zebra", "echo replaced");

    term.stylePrint.mockClear();
    commands.alias([]);
    expect(term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "__proto__=echo proto",
      "constructor=echo constructor",
      "zebra=echo replaced",
    ]);

    term.stylePrint.mockClear();
    commands.alias(["constructor"]);
    expect(term.stylePrint).toHaveBeenCalledOnce();
    expect(term.stylePrint).toHaveBeenCalledWith(
      "constructor=echo constructor"
    );
  });

  it("reports an undefined alias query without mutating aliases", () => {
    const { commands, term } = loadCommands();

    commands.alias(["missing"]);

    expect(term.stylePrint).toHaveBeenCalledWith(
      "alias: missing: not defined"
    );
    expect(term.defineAlias).not.toHaveBeenCalled();
    expect(term.removeAlias).not.toHaveBeenCalled();
    expect(term.getAliases()).toEqual([]);
  });

describe("alias documentation", () => {
  it("prints command-specific manuals for alias and unalias", () => {
    const { commands, term } = loadCommands();

    commands.man(["alias"]);
    expect(term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "alias: define, list, or query command aliases - usage:",
      "%alias% name=value  define or replace an alias",
      "%alias%             list all aliases sorted by name",
      "%alias% name        print one alias",
    ]);

    term.stylePrint.mockClear();
    commands.man(["unalias"]);
    expect(term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "unalias: remove a command alias - usage:",
      "%unalias% name",
    ]);
  });

  it("retains portfolio lookup for man and woman", () => {
    const { commands, term } = loadCommands();
    term.command = vi.fn();

    commands.man(["esper"]);
    expect(term.command).toHaveBeenCalledWith({ cmd: "tldr", args: ["esper"] });

    term.command.mockClear();
    commands.woman(["esper"]);
    expect(term.command).toHaveBeenCalledWith({ cmd: "tldr", args: ["esper"] });
  });
});

  it("removes an alias and reports an unknown name without mutation", () => {
    const { commands, term } = loadCommands();
    commands.alias(["kept=echo", "safe"]);
    commands.alias(["gone=echo", "remove"]);

    commands.unalias(["gone"]);
    expect(term.removeAlias).toHaveBeenCalledOnce();
    expect(term.removeAlias).toHaveBeenCalledWith("gone");
    expect(term.getAlias("gone")).toBeUndefined();

    term.removeAlias.mockClear();
    commands.unalias(["missing"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(
      "unalias: missing: not defined"
    );
    expect(term.removeAlias).not.toHaveBeenCalled();
    expect(term.getAlias("kept")).toBe("echo safe");
  });

  it("rejects invalid names and malformed forms before state mutation", () => {
    for (const args of [["bad-name=value"], ["9name=value"], ["=value"], ["name", "value"]]) {
      const { commands, term } = loadCommands();
      commands.alias(args);
      expect(term.stylePrint).toHaveBeenCalledWith(
        expect.stringContaining("alias: invalid")
      );
      expect(term.defineAlias).not.toHaveBeenCalled();
      expect(term.removeAlias).not.toHaveBeenCalled();
      expect(term.getAliases()).toEqual([]);
    }

    for (const args of [[], ["bad-name"], ["one", "two"]]) {
      const { commands, term } = loadCommands();
      commands.unalias(args);
      expect(term.stylePrint).toHaveBeenCalledWith(
        expect.stringContaining("unalias: invalid")
      );
      expect(term.defineAlias).not.toHaveBeenCalled();
      expect(term.removeAlias).not.toHaveBeenCalled();
      expect(term.getAliases()).toEqual([]);
    }
  });

  it("reports persistence failures while preserving terminal state", () => {
    const { commands, term } = loadCommands();
    term.defineAlias.mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    commands.alias(["safe=echo", "safe"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(
      "alias: unable to save aliases; no changes were made"
    );
    expect(term.getAliases()).toEqual([]);
  });
});

describe("cd", () => {
  // Table ported from #51 (@astonm, 2021), which never landed. The cases still
  // describe the intended behaviour; only the harness has changed.
  it.each([
    ["anywhere", "/", "/"],
    ["anywhere", "~", "~"],
    ["anywhere", "~/", "~"],
    ["~", "..", "home"],
    ["~", "../", "home"],
    ["anywhere", "../../", "/"],
    ["anywhere", "../..", "/"],
    ["anywhere", "../../../", "/"],
    ["anywhere", "../../../../", "/"],
    ["/", "home", "home"],
    ["anywhere", "/home", "home"],
    ["/", "bin", "bin"],
    ["anywhere", ".", "anywhere"],
    ["anywhere", "./", "anywhere"],
    ["anywhere", "", "~"],
    ["anywhere", "/bin", "bin"],
  ])("from %s, cd %s -> %s", (cwd, arg, expected) => {
    const { commands, term } = loadCommands({ cwd });
    commands.cd(arg === "" ? [] : [arg]);
    expect(term.cwd).toBe(expected);
  });

  it("refuses a team member's home directory without moving", () => {
    const { commands, term } = loadCommands({ cwd: "home" });
    commands.cd(["avidan"]);
    expect(term.cwd).toBe("home");
    expect(term.stylePrint).toHaveBeenCalledWith(
      "You do not have permission to access this directory"
    );
  });

  it("lets a user into their own home but not someone else's", () => {
    const mine = loadCommands({ cwd: "home", user: "guest" });
    mine.commands.cd(["guest"]);
    expect(mine.term.cwd).toBe("~");

    const theirs = loadCommands({ cwd: "home", user: "guest" });
    theirs.commands.cd(["root"]);
    expect(theirs.term.cwd).toBe("home");
    expect(theirs.term.stylePrint).toHaveBeenCalledWith(
      "You do not have permission to access this directory"
    );
  });

  it("reports unknown directories without moving", () => {
    const { commands, term } = loadCommands({ cwd: "~" });
    commands.cd(["nope"]);
    expect(term.cwd).toBe("~");
    expect(term.stylePrint).toHaveBeenCalledWith("No such directory: nope");
  });
});

describe("help stays in sync with commands", () => {
  // config/help.js is what `help` prints. Nothing links the two files, so a
  // command can be listed without existing — which is exactly what happened
  // when a bad merge dropped `swag` from commands.js while help.js kept
  // advertising it, leaving `help` pointing at a command that did nothing.
  const helpContext = vm.createContext({ module: { exports: {} } });
  vm.runInContext(
    `${readFileSync("config/help.js", "utf8")}\nthis.helpEntries = help;`,
    helpContext
  );

  it("advertises no command that does not exist", () => {
    const { commands } = loadCommands();
    const advertised = Object.keys(helpContext.helpEntries)
      .map((entry) => entry.match(/^%([a-z_]+)%/))
      .filter(Boolean)
      .map((match) => match[1]);

    expect(advertised.length).toBeGreaterThan(0);
    const missing = advertised.filter(
      (name) => typeof commands[name] !== "function"
    );
    expect(missing).toEqual([]);
  });

  it("advertises alias and unalias with their supported syntax", () => {
    expect(helpContext.helpEntries).toMatchObject({
      "%alias% [name[=value]]": "define, list, or query command aliases",
      "%unalias% name": "remove a command alias",
    });
  });
});

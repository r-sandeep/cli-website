import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const commandSource = readFileSync("config/commands.js", "utf8");
const jobsContext = vm.createContext({ module: { exports: {} } });
vm.runInContext(`${readFileSync("config/jobs.js", "utf8")}\nthis.productionJobs = jobs;`, jobsContext);
const productionJobs = jobsContext.productionJobs;
const testJobs = { ...productionJobs, 2: ["Platform Engineer"] };
const bookmarkSource = readFileSync("js/bookmarks.js", "utf8");

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key) => values.has(key) ? values.get(key) : null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    removeItem: vi.fn((key) => values.delete(key)),
  };
}
const helpContext = vm.createContext({ module: { exports: {} } });
vm.runInContext(
  `${readFileSync("config/help.js", "utf8")}\nthis.helpEntries = help; this.shortcutEntries = shortcuts;`,
  helpContext
);

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
      await expect(apply([id])).resolves.toBe(1);
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
    await expect(apply(["1"])).resolves.toBe(1);
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
      await expect(apply(["1"])).resolves.toBe(1);
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
function loadCommands({
  cwd = "~",
  user = "guest",
  team = { avidan: {} },
  storage = createMemoryStorage(),
  help = {},
  portfolio = {},
} = {}) {
  const aliases = new Map();
  const location = {
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  };
  const term = {
    cwd,
    user,
    stylePrint: vi.fn(),
    writeln: vi.fn(),
    printArt: vi.fn(),
    openURL: vi.fn(),
    displayURL: vi.fn(),
    init: vi.fn(),
    prompt: vi.fn(),
    clearCurrentLine: vi.fn(),
    collectInput: vi.fn(),
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
    // Callers that pass `help` (the pipeline help tests) keep it; bare callers get the real
    // entries so the help/man/shortcut tests see the full registry. `shortcuts` is always the
    // real table from config/help.js.
    help: Object.keys(help).length > 0 ? help : helpContext.helpEntries,
    shortcuts: helpContext.shortcutEntries,
    portfolio,
    buildInfo: Object.freeze({ version: "1.2.3-test", buildDate: "2030-04-05" }),
    colorText: (text) => text,
    localStorage: storage,
    window: { location },
  });
  vm.runInContext(bookmarkSource, context);
  vm.runInContext(commandSource, context);
  const commands = vm.runInContext("commands", context);
  // Redirecting commands preserve their prepared argument arrays when they
  // recurse; the raw-line seam remains available for compatibility (cd recurses
  // through term.command for the paths that resolve via another cd).
  term.dispatchCommand = (name, args) => commands[name](args);
  term.command = vi.fn((line) => {
    const [name, ...args] = line.split(" ");
    return term.dispatchCommand(name, args);
  });
  return { commands, location, storage, term };
}

describe("version", () => {
  it("prints the injected metadata as exactly one unwrapped plain line", () => {
    const { commands, term } = loadCommands();

    commands.version([]);

    expect(term.stylePrint).toHaveBeenCalledTimes(1);
    expect(term.stylePrint).toHaveBeenCalledWith(
      "Root Ventures terminal v1.2.3-test (build 2030-04-05)",
      false
    );
  });

  it("serializes only the injected version and build date as compact JSON", () => {
    const { commands, term } = loadCommands();

    commands.version(["--json"]);

    expect(term.stylePrint).toHaveBeenCalledTimes(1);
    const [line, wrap] = term.stylePrint.mock.calls[0];
    expect(line).toBe('{"version":"1.2.3-test","buildDate":"2030-04-05"}');
    expect(JSON.parse(line)).toEqual({
      version: "1.2.3-test",
      buildDate: "2030-04-05",
    });
    expect(Object.keys(JSON.parse(line))).toEqual(["version", "buildDate"]);
    expect(wrap).toBe(false);
  });

  it.each([
    [["--text"]],
    [["--json", "extra"]],
    [["--JSON"]],
    [[""]],
  ])("rejects invalid arguments with usage and no mutation or dispatch: %j", (args) => {
    const { commands, storage, term } = loadCommands({ cwd: "bin" });
    const storageBefore = storage.getItem("rootvc.bookmarks.v1");
    term.dispatchCommand = vi.fn();

    commands.version(args);

    expect(term.stylePrint).toHaveBeenCalledTimes(1);
    expect(term.stylePrint).toHaveBeenCalledWith(
      "Usage: version [--json]",
      false
    );
    expect(term.dispatchCommand).not.toHaveBeenCalled();
    expect(term.cwd).toBe("bin");
    expect(term.user).toBe("guest");
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(storageBefore);
    expect(term.openURL).not.toHaveBeenCalled();
    expect(term.displayURL).not.toHaveBeenCalled();
    expect(term.init).not.toHaveBeenCalled();
  });
});

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
    // Since the pipelines merge, `man` falls back through the raw-line seam and
    // redirect aliases such as `woman` forward prepared arguments unchanged.
    const { commands, term } = loadCommands();
    term.command = vi.fn();
    term.dispatchCommand = vi.fn();

    commands.man(["esper"]);
    expect(term.command).toHaveBeenCalledWith("tldr esper");

    commands.woman(["esper"]);
    expect(term.dispatchCommand).toHaveBeenCalledWith("tldr", ["esper"]);
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

function createEnvironmentDouble(
  initialEntries = [],
  { setFailure = null, unsetFailure = null } = {}
) {
  let state = new Map(initialEntries);
  const result = (ok, code, message = "") => ({ ok, code, message });
  const api = {
    snapshot: vi.fn(() => new Map(state)),
    entries: vi.fn(() => [...state.entries()]),
    set: vi.fn((name, value) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        return result(
          false,
          "invalid",
          "Invalid environment variable name. Use letters, digits, and underscores, starting with a letter or underscore."
        );
      }
      if (setFailure) return setFailure;
      if (!state.has(name) && state.size >= 50) {
        return result(false, "capacity", "Environment variable limit of 50 reached.");
      }
      const candidate = new Map(state);
      candidate.set(name, value);
      state = candidate;
      return result(true, "updated");
    }),
    unset: vi.fn((name) => {
      if (!state.has(name)) return result(true, "absent");
      if (unsetFailure) return unsetFailure;
      const candidate = new Map(state);
      candidate.delete(name);
      state = candidate;
      return result(true, "updated");
    }),
  };
  return api;
}

function loadEnvironmentCommands(initialEntries = [], options = {}) {
  const loaded = loadCommands();
  loaded.term.environment = createEnvironmentDouble(initialEntries, options);
  loaded.term.init = vi.fn();
  loaded.term.clearCurrentLine = vi.fn();
  loaded.term.prompt = vi.fn();
  loaded.term.location = { navigate: vi.fn(), reload: vi.fn() };
  return loaded;
}

describe("environment commands", () => {
  it("stores exact and empty values, splitting only on the first equals sign", () => {
    const { commands, term } = loadEnvironmentCommands();

    commands.export(["TOKEN=alpha=beta"]);
    expect(term.environment.set).toHaveBeenLastCalledWith("TOKEN", "alpha=beta");
    expect([...term.environment.snapshot()]).toEqual([["TOKEN", "alpha=beta"]]);
    expect(term.stylePrint).not.toHaveBeenCalled();

    commands.export(["EMPTY="]);
    expect(term.environment.set).toHaveBeenLastCalledWith("EMPTY", "");
    expect([...term.environment.snapshot()]).toEqual([
      ["TOKEN", "alpha=beta"],
      ["EMPTY", ""],
    ]);
    expect(term.stylePrint).not.toHaveBeenCalled();
  });

  it("rejects invalid and missing assignments with actionable errors and no state change", () => {
    const invalid = loadEnvironmentCommands([["SAFE", "before"]]);
    const invalidBefore = [...invalid.term.environment.snapshot()];
    invalid.commands.export(["9BAD=value"]);
    expect(invalid.term.stylePrint).toHaveBeenCalledWith(
      "export: Invalid environment variable name. Use letters, digits, and underscores, starting with a letter or underscore."
    );
    expect([...invalid.term.environment.snapshot()]).toEqual(invalidBefore);

    const missing = loadEnvironmentCommands([["SAFE", "before"]]);
    const missingBefore = [...missing.term.environment.snapshot()];
    missing.commands.export(["SAFE"]);
    expect(missing.term.stylePrint).toHaveBeenCalledWith(
      "export: expected one NAME=value assignment."
    );
    expect(missing.term.environment.set).not.toHaveBeenCalled();
    expect([...missing.term.environment.snapshot()]).toEqual(missingBefore);

    const multiple = loadEnvironmentCommands([["SAFE", "before"]]);
    const multipleBefore = [...multiple.term.environment.snapshot()];
    multiple.commands.export(["SAFE=after", "EXTRA=value"]);
    expect(multiple.term.stylePrint).toHaveBeenCalledWith(
      "export: expected one NAME=value assignment."
    );
    expect(multiple.term.environment.set).not.toHaveBeenCalled();
    expect([...multiple.term.environment.snapshot()]).toEqual(multipleBefore);
  });

  it("prints export and env listings once in lexical order including empty values", () => {
    const { commands, term } = loadEnvironmentCommands([
      ["ZED", "last"],
      ["EMPTY", ""],
      ["ALPHA", "first"],
    ]);

    commands.export([]);
    expect(term.stylePrint.mock.calls).toEqual([
      ["ALPHA=first"],
      ["EMPTY="],
      ["ZED=last"],
    ]);
    expect(term.environment.entries).toHaveBeenCalledTimes(1);

    term.stylePrint.mockClear();
    commands.env([]);
    expect(term.stylePrint.mock.calls).toEqual([
      ["ALPHA=first"],
      ["EMPTY="],
      ["ZED=last"],
    ]);
    expect(term.environment.entries).toHaveBeenCalledTimes(2);
  });

  it("reports capacity and persistence failures without leaking state", () => {
    const fullEntries = Array.from({ length: 50 }, (_, index) => [
      `V${index}`,
      String(index),
    ]);
    const full = loadEnvironmentCommands(fullEntries);
    const fullBefore = [...full.term.environment.snapshot()];
    full.commands.export(["OVER=value"]);
    expect(full.term.stylePrint).toHaveBeenCalledWith(
      "export: Environment variable limit of 50 reached."
    );
    expect([...full.term.environment.snapshot()]).toEqual(fullBefore);

    const storageFailure = {
      ok: false,
      code: "storage",
      message: "Environment variables could not be saved. Storage is unavailable.",
    };
    const failedSet = loadEnvironmentCommands([["SAFE", "before"]], {
      setFailure: storageFailure,
    });
    const setBefore = [...failedSet.term.environment.snapshot()];
    failedSet.commands.export(["SAFE=after"]);
    expect(failedSet.term.stylePrint).toHaveBeenCalledWith(
      "export: Environment variables could not be saved. Storage is unavailable."
    );
    expect([...failedSet.term.environment.snapshot()]).toEqual(setBefore);

    const failedUnset = loadEnvironmentCommands([["SAFE", "before"]], {
      unsetFailure: storageFailure,
    });
    const unsetBefore = [...failedUnset.term.environment.snapshot()];
    failedUnset.commands.unset(["SAFE"]);
    expect(failedUnset.term.stylePrint).toHaveBeenCalledWith(
      "unset: Environment variables could not be saved. Storage is unavailable."
    );
    expect([...failedUnset.term.environment.snapshot()]).toEqual(unsetBefore);
  });

  it("composes overwrite, rejection, unset, refill, and absent unset transitions", () => {
    const fullEntries = Array.from({ length: 50 }, (_, index) => [
      `V${index}`,
      String(index),
    ]);
    const { commands, term } = loadEnvironmentCommands(fullEntries);

    commands.export(["V0=replaced"]);
    expect(term.environment.snapshot().get("V0")).toBe("replaced");
    expect(term.stylePrint).not.toHaveBeenCalled();

    const invalidBefore = [...term.environment.snapshot()];
    commands.export(["NOT-VALID=value"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(
      "export: Invalid environment variable name. Use letters, digits, and underscores, starting with a letter or underscore."
    );
    expect([...term.environment.snapshot()]).toEqual(invalidBefore);

    term.stylePrint.mockClear();
    commands.unset(["V0"]);
    expect(term.environment.snapshot().has("V0")).toBe(false);
    expect(term.stylePrint).not.toHaveBeenCalled();

    commands.export(["REFILL=ready"]);
    expect(term.environment.snapshot().get("REFILL")).toBe("ready");
    expect(term.stylePrint).not.toHaveBeenCalled();

    const absentBefore = [...term.environment.snapshot()];
    commands.unset(["MISSING"]);
    expect(term.environment.unset).toHaveBeenLastCalledWith("MISSING");
    expect([...term.environment.snapshot()]).toEqual(absentBefore);
    expect(term.stylePrint).not.toHaveBeenCalled();

    commands.unset(["NOT-VALID"]);
    expect(term.environment.unset).toHaveBeenLastCalledWith("NOT-VALID");
    expect([...term.environment.snapshot()]).toEqual(absentBefore);
    expect(term.stylePrint).not.toHaveBeenCalled();
  });

  it("does not bypass the normal command lifecycle for environment handlers", () => {
    const { commands, term } = loadEnvironmentCommands([["NAME", "value"]]);

    commands.export(["NAME=next"]);
    commands.env([]);
    commands.unset(["NAME"]);
    expect(term.init).not.toHaveBeenCalled();
    expect(term.clearCurrentLine).not.toHaveBeenCalled();
    expect(term.prompt).not.toHaveBeenCalled();
    expect(term.location.navigate).not.toHaveBeenCalled();
    expect(term.location.reload).not.toHaveBeenCalled();
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

describe("bookmark and go", () => {
  it("adds every valid NAME form at the current cwd and rejects an invalid name atomically", () => {
    const { commands, storage, term } = loadCommands({ cwd: "bin" });

    for (const name of ["work", "Work_2", "dash-name", "__proto__"]) {
      commands.bookmark(["add", name]);
      expect(term.stylePrint).toHaveBeenLastCalledWith(`Bookmark ${name} saved: bin`);
    }
    const beforeInvalid = storage.getItem("rootvc.bookmarks.v1");
    commands.bookmark(["add", "bad.name"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(
      'Invalid bookmark name "bad.name". NAME must match [A-Za-z0-9_-]+.'
    );
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(beforeInvalid);
    expect(term.command).not.toHaveBeenCalled();
    expect(term.init).not.toHaveBeenCalled();
    expect(term.prompt).not.toHaveBeenCalled();
    expect(term.clearCurrentLine).not.toHaveBeenCalled();
    expect(term.collectInput).not.toHaveBeenCalled();
  });

  it("rejects a duplicate without changing the persisted bookmark", () => {
    const { commands, storage, term } = loadCommands({ cwd: "home" });
    commands.bookmark(["add", "desk"]);
    const beforeDuplicate = storage.getItem("rootvc.bookmarks.v1");
    term.cwd = "bin";

    commands.bookmark(["add", "desk"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith('Bookmark "desk" already exists.');
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(beforeDuplicate);
    term.stylePrint.mockClear();
    commands.bookmark(["list"]);
    expect(term.stylePrint).toHaveBeenCalledWith("desk -> home");
  });

  it("prints an empty state and lists entries in deterministic name order", () => {
    const { commands, term } = loadCommands();
    commands.bookmark(["list"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith("No bookmarks saved.");

    term.cwd = "bin";
    commands.bookmark(["add", "zeta"]);
    term.cwd = "home";
    commands.bookmark(["add", "Alpha"]);
    term.stylePrint.mockClear();
    commands.bookmark(["list"]);
    expect(term.stylePrint.mock.calls.map(([line]) => line)).toEqual([
      "Alpha -> home",
      "zeta -> bin",
    ]);
  });

  it("removes a present bookmark and rejects an absent name without changing state", () => {
    const { commands, storage, term } = loadCommands();
    commands.bookmark(["add", "kept"]);
    commands.bookmark(["add", "gone"]);

    commands.bookmark(["remove", "gone"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith('Bookmark "gone" removed.');
    const afterRemoval = storage.getItem("rootvc.bookmarks.v1");
    commands.bookmark(["remove", "missing"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith('Bookmark "missing" not found.');
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(afterRemoval);
  });

  it("navigates to a bookmark by changing only cwd and preserves cwd for unknown names", () => {
    const { commands, location, term } = loadCommands({ cwd: "home" });
    commands.bookmark(["add", "origin"]);
    term.cwd = "bin";
    term.stylePrint.mockClear();
    term.command.mockClear();

    commands.go(["origin"]);
    expect(term.cwd).toBe("home");
    expect(term.stylePrint).not.toHaveBeenCalled();
    expect(term.command).not.toHaveBeenCalled();
    expect(term.init).not.toHaveBeenCalled();
    expect(term.prompt).not.toHaveBeenCalled();
    expect(term.clearCurrentLine).not.toHaveBeenCalled();
    expect(term.collectInput).not.toHaveBeenCalled();
    expect(location.assign).not.toHaveBeenCalled();
    expect(location.replace).not.toHaveBeenCalled();
    expect(location.reload).not.toHaveBeenCalled();

    term.stylePrint.mockClear();
    commands.go(["unknown"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith('Bookmark "unknown" not found.');
    expect(term.cwd).toBe("home");
  });

  it("rejects malformed command shapes with usage and no mutation or dispatch", () => {
    for (const args of [[], ["add"], ["add", "name", "extra"], ["list", "extra"], ["remove"], ["unknown"]]) {
      const { commands, storage, term } = loadCommands({ cwd: "bin" });
      const before = storage.getItem("rootvc.bookmarks.v1");
      commands.bookmark(args);
      expect(term.stylePrint).toHaveBeenLastCalledWith(
        "Usage: bookmark add NAME | bookmark list | bookmark remove NAME"
      );
      expect(storage.getItem("rootvc.bookmarks.v1")).toBe(before);
      expect(term.cwd).toBe("bin");
      expect(term.command).not.toHaveBeenCalled();
    }

    for (const args of [[], ["name", "extra"]]) {
      const { commands, term } = loadCommands({ cwd: "bin" });
      commands.go(args);
      expect(term.stylePrint).toHaveBeenLastCalledWith("Usage: go NAME");
      expect(term.cwd).toBe("bin");
      expect(term.command).not.toHaveBeenCalled();
    }
  });

  it("surfaces invalid go and remove names without mutation", () => {
    const { commands, storage, term } = loadCommands({ cwd: "bin" });
    const before = storage.getItem("rootvc.bookmarks.v1");

    commands.bookmark(["remove", "bad.name"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(
      'Invalid bookmark name "bad.name". NAME must match [A-Za-z0-9_-]+.'
    );
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(before);

    commands.go(["bad.name"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(
      'Invalid bookmark name "bad.name". NAME must match [A-Za-z0-9_-]+.'
    );
    expect(term.cwd).toBe("bin");
  });

  it("rejects the twenty-sixth addition while retaining all 25 persisted entries", () => {
    const storage = createMemoryStorage();
    const first = loadCommands({ storage });
    for (let index = 0; index < 25; index++) {
      first.term.cwd = `path-${index}`;
      first.commands.bookmark(["add", `name-${String(index).padStart(2, "0")}`]);
    }
    const beforeLimit = storage.getItem("rootvc.bookmarks.v1");

    first.commands.bookmark(["add", "overflow"]);
    expect(first.term.stylePrint).toHaveBeenLastCalledWith(
      'Cannot add bookmark "overflow": limit of 25 reached.'
    );
    expect(storage.getItem("rootvc.bookmarks.v1")).toBe(beforeLimit);

    const reloaded = loadCommands({ storage });
    reloaded.commands.bookmark(["list"]);
    const lines = reloaded.term.stylePrint.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(25);
    expect(lines[0]).toBe("name-00 -> path-0");
    expect(lines[24]).toBe("name-24 -> path-24");
  });

  it("reports read and write storage failures without changing terminal state", () => {
    const unreadableStorage = {
      getItem: vi.fn(() => { throw new Error("blocked"); }),
      setItem: vi.fn(),
    };
    const unreadable = loadCommands({ cwd: "home", storage: unreadableStorage });
    unreadable.commands.bookmark(["add", "desk"]);
    expect(unreadable.term.stylePrint).toHaveBeenLastCalledWith(
      'Could not save bookmark "desk": browser storage is unavailable.'
    );
    expect(unreadableStorage.setItem).not.toHaveBeenCalled();
    unreadable.commands.bookmark(["list"]);
    expect(unreadable.term.stylePrint).toHaveBeenLastCalledWith(
      "Could not list bookmarks: browser storage is unavailable or corrupt."
    );
    unreadable.commands.go(["desk"]);
    expect(unreadable.term.stylePrint).toHaveBeenLastCalledWith(
      'Could not open bookmark "desk": browser storage is unavailable.'
    );
    expect(unreadable.term.cwd).toBe("home");

    const writeFailure = createMemoryStorage();
    writeFailure.setItem.mockImplementation(() => { throw new Error("full"); });
    const unwritable = loadCommands({ cwd: "bin", storage: writeFailure });
    unwritable.commands.bookmark(["add", "desk"]);
    expect(unwritable.term.stylePrint).toHaveBeenLastCalledWith(
      'Could not save bookmark "desk": browser storage is unavailable.'
    );
    expect(writeFailure.getItem("rootvc.bookmarks.v1")).toBeNull();
  });
});

describe("man", () => {
  it("documents both version output forms without delegating", () => {
    const { commands, term } = loadCommands();

    commands.man(["version"]);

    const output = term.stylePrint.mock.calls.map(([line]) => line);
    expect(output).toContain("Usage: version [--json]");
    expect(output).toContain("With no option, print the human-readable version line.");
    expect(output).toContain("With --json, print a compact object with version and buildDate.");
    expect(term.command).not.toHaveBeenCalled();
  });

  it("documents bookmark and go without delegating", () => {
    const { commands, term } = loadCommands();
    commands.man(["bookmark"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(expect.stringContaining("bookmark add NAME"));
    expect(term.stylePrint).toHaveBeenLastCalledWith(expect.stringContaining("bookmark list"));
    expect(term.stylePrint).toHaveBeenLastCalledWith(expect.stringContaining("bookmark remove NAME"));
    expect(term.command).not.toHaveBeenCalled();

    term.stylePrint.mockClear();
    commands.man(["go"]);
    expect(term.stylePrint).toHaveBeenLastCalledWith(expect.stringContaining("Usage: go NAME"));
    expect(term.command).not.toHaveBeenCalled();
  });

  it("delegates every unrelated target through the pre-feature tldr path", () => {
    const { commands, term } = loadCommands();
    commands.man(["example"]);
    expect(term.command).toHaveBeenCalledWith("tldr example");
    expect(term.stylePrint).toHaveBeenCalledWith(
      "Portfolio company example not found. Should we talk to them? Email us: hello@example.com"
    );
  });
});

describe("prepared command forwarding", () => {
  it("forwards aliases without reparsing or expanding prepared arguments", () => {
    const { commands, term } = loadCommands();
    const args = ["value with spaces", "$LITERAL", ""];
    term.dispatchCommand = vi.fn();

    commands.tail(args);

    expect(term.dispatchCommand).toHaveBeenCalledWith("cat", args);
    expect(term.dispatchCommand.mock.calls[0][1]).toBe(args);
  });

  it("forwards sudo arguments once as a command token and unchanged arguments", () => {
    const { commands, term } = loadCommands({ user: "root" });
    const forwarded = ["value with spaces", "$LITERAL", ""];
    term.dispatchCommand = vi.fn();

    commands.sudo(["EcHo", ...forwarded]);

    expect(term.dispatchCommand).toHaveBeenCalledWith("echo", forwarded);
  });
});

describe("help stays in sync with commands", () => {
  // config/help.js is what `help` prints. Nothing links the two files, so a
  // command can be listed without existing — which is exactly what happened
  // when a bad merge dropped `swag` from commands.js while help.js kept
  // advertising it, leaving `help` pointing at a command that did nothing.
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

  it("advertises version with its optional JSON form", () => {
    expect(helpContext.helpEntries).toMatchObject({
      "%version% [--json]": "show the terminal version and build date",
    });

    const { commands, term } = loadCommands({ help: helpContext.helpEntries });
    commands.help([]);
    expect(term.stylePrint.mock.calls.flat().join("\n")).toContain(
      "%version% [--json]"
    );
  });

  it("advertises every bookmark and navigation form", () => {
    expect(helpContext.helpEntries["%bookmark% add NAME"]).toContain("save");
    expect(helpContext.helpEntries["%bookmark% list"]).toContain("list");
    expect(helpContext.helpEntries["%bookmark% remove NAME"]).toContain("remove");
    expect(helpContext.helpEntries["%go% NAME"]).toContain("NAME");

    const { commands, term } = loadCommands({ help: helpContext.helpEntries });
    commands.help([]);
    const output = term.stylePrint.mock.calls.map(([line]) => line);
    expect(output.some((line) => line.includes("%bookmark% add NAME"))).toBe(true);
    expect(output.some((line) => line.includes("%bookmark% list"))).toBe(true);
    expect(output.some((line) => line.includes("%bookmark% remove NAME"))).toBe(true);
    expect(output.some((line) => line.includes("%go% NAME"))).toBe(true);
  });

  it("renders the environment commands and complete expansion grammar", () => {
    const { commands, term } = loadCommands({ help: helpContext.helpEntries });

    commands.help([]);

    const output = term.stylePrint.mock.calls.flat().join("\n");
    expect(output).toContain("%export% NAME=value");
    expect(output).toContain("%env%");
    expect(output).toContain("%unset% NAME");
    expect(output).toContain("$NAME");
    expect(output).toContain("${NAME}");
    expect(output).toContain("undefined names become empty");
    expect(output).toContain("\\$NAME escapes expansion");
  });
});

describe("environment manuals", () => {
  it.each([
    ["export", "Usage: export NAME=value"],
    ["env", "Usage: env"],
    ["unset", "Usage: unset NAME"],
  ])("documents man %s and the expansion syntax", (topic, usage) => {
    const { commands, term } = loadCommands();

    commands.man([topic]);

    const output = term.stylePrint.mock.calls.flat().join("\n");
    expect(output).toContain(usage);
    expect(output).toContain("$NAME");
    expect(output).toContain("${NAME}");
    expect(output).toContain("undefined names become empty");
    expect(output).toContain("\\$NAME keeps the reference literal");
  });

  it("keeps non-environment man topics on the executable tldr portfolio path", () => {
    const portfolio = {
      example: {
        name: "Example Company",
        url: "https://example.com",
        description: "Representative portfolio description.",
      },
    };
    const { commands, term } = loadCommands({ portfolio });

    commands.man(["example"]);

    expect(term.stylePrint).toHaveBeenCalledWith("Example Company");
    expect(term.stylePrint).toHaveBeenCalledWith("https://example.com");
    expect(term.stylePrint).toHaveBeenCalledWith(
      "Representative portfolio description."
    );
  });
});

describe("help output (pipelines)", () => {
  it("documents pipeline syntax, every filter, flags, defaults, and chaining", () => {
    const { commands, term } = loadCommands({ help: helpContext.helpEntries });
    commands.help();

    const output = term.stylePrint.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("PIPELINES");
    expect(output).toContain("COMMAND | %grep% [-ivn] PATTERN");
    expect(output).toContain("-i case-insensitive, -v invert, -n number");
    expect(output).toContain("COMMAND | %head% [N]");
    expect(output).toContain("COMMAND | %tail% [N]");
    expect(output).toContain("default: 10");
    expect(output).toContain("COMMAND | %wc% -l");
    expect(output).toContain("COMMAND | %sort% [-rnu]");
    expect(output).toContain("-r reverse, -n numeric, -u unique");
    expect(output).toContain("COMMAND | %uniq% [-cd]");
    expect(output).toContain("-c count, -d repeated only");
    expect(output).toContain("%whois% | %grep% -i root | %head% 3");
  });
});

describe("pipeline manual pages preserve standalone commands", () => {
  it.each([
    ["pipe", "COMMAND | FILTER [| FILTER ...]"],
    ["grep", "COMMAND | %grep% [-ivn] PATTERN"],
    ["head", "COMMAND | %head% [N]"],
    ["tail", "COMMAND | %tail% [N]"],
    ["wc", "COMMAND | %wc% -l"],
    ["sort", "COMMAND | %sort% [-rnu]"],
    ["uniq", "COMMAND | %uniq% [-cd]"],
  ])("documents man %s", (topic, expected) => {
    const { commands, term } = loadCommands();
    commands.man([topic]);
    expect(term.stylePrint.mock.calls.map(([line]) => line).join("\n")).toContain(expected);
  });

  it("documents every sort and uniq flag", () => {
    const sortRun = loadCommands();
    sortRun.commands.man(["sort"]);
    const sortOutput = sortRun.term.stylePrint.mock.calls.flat().join("\n");
    expect(sortOutput).toContain("-r reverses the order");
    expect(sortOutput).toContain("-n compares leading numeric values");
    expect(sortOutput).toContain("-u removes exact duplicates after sorting");
    expect(sortOutput).toContain("Flags may be combined, for example -rn");
    expect(sortOutput).toContain("ANSI color and escape sequences are ignored");

    const uniqRun = loadCommands();
    uniqRun.commands.man(["uniq"]);
    const uniqOutput = uniqRun.term.stylePrint.mock.calls.flat().join("\n");
    expect(uniqOutput).toContain("-c prefixes each survivor with its run count and one space");
    expect(uniqOutput).toContain("-d keeps only repeated runs");
    expect(uniqOutput).toContain("Flags may be combined as -cd");
    expect(uniqOutput).toContain("ANSI color and escape sequences are ignored");
  });

  it("keeps portfolio and unknown man topics on the existing tldr fallback", () => {
    const { commands } = loadCommands();
    commands.tldr = vi.fn();

    commands.man(["portfolio_company"]);
    expect(commands.tldr).toHaveBeenLastCalledWith(["portfolio_company"]);
    commands.man(["unknown_topic"]);
    expect(commands.tldr).toHaveBeenLastCalledWith(["unknown_topic"]);
  });

  it("keeps standalone head and tail as cat aliases and woman as a tldr alias", () => {
    const { commands } = loadCommands();
    commands.cat = vi.fn();
    commands.tldr = vi.fn();

    commands.head(["README.md"]);
    expect(commands.cat).toHaveBeenCalledWith(["README.md"]);
    commands.tail(["welcome.htm"]);
    expect(commands.cat).toHaveBeenCalledWith(["welcome.htm"]);
    commands.woman(["root"]);
    expect(commands.tldr).toHaveBeenCalledWith(["root"]);
    expect(typeof commands.grep).toBe("function");
    expect(commands.grep).not.toBe(commands.man);
  });
});

describe("terminal editing documentation", () => {
  const expectedShortcuts = [
    "Tab",
    "Alt+Left",
    "Alt+Right",
    "Ctrl+W",
    "Alt+D",
    "Ctrl+A",
    "Ctrl+E",
    "Ctrl+U",
  ];

  it("prints every shortcut in help and man shortcuts", () => {
    const helpRun = loadCommands();
    helpRun.commands.help([]);
    const helpOutput = helpRun.term.stylePrint.mock.calls.flat().join("\n");

    const manRun = loadCommands();
    manRun.commands.man(["shortcuts"]);
    const manOutput = manRun.term.stylePrint.mock.calls.flat().join("\n");

    for (const chord of expectedShortcuts) {
      expect(helpOutput).toContain(
        `${chord}: ${helpContext.shortcutEntries[chord]}`
      );
      expect(manOutput).toContain(
        `${chord}: ${helpContext.shortcutEntries[chord]}`
      );
    }
    expect(manRun.term.command).not.toHaveBeenCalled();
  });

  it("keeps bare man, company man, woman, and tldr on the existing tldr path", () => {
    const { commands, term } = loadCommands();

    commands.man([]);
    expect(term.command).toHaveBeenLastCalledWith("tldr");

    commands.man(["fictiv"]);
    expect(term.command).toHaveBeenLastCalledWith("tldr fictiv");

    commands.woman(["fictiv"]);
    expect(term.command).toHaveBeenLastCalledWith("tldr fictiv");

    commands.tldr([]);
    expect(term.stylePrint).toHaveBeenCalled();
  });

  it("keeps the README shortcut list consistent with terminal output", () => {
    const readme = readFileSync("README.md", "utf8");

    for (const chord of expectedShortcuts) {
      expect(readme).toContain(
        `**${chord}** — ${helpContext.shortcutEntries[chord]}`
      );
    }
    expect(readme).toContain("`man shortcuts`");
  });
});

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
function loadCommands({
  cwd = "~",
  user = "guest",
  team = { avidan: {} },
  storage = createMemoryStorage(),
  help = {},
} = {}) {
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
  };
  const context = vm.createContext({
    term,
    jobs: productionJobs,
    firm: { blurb: "", email: "hello@example.com" },
    team,
    help,
    portfolio: {},
    colorText: (text) => text,
    localStorage: storage,
    window: { location },
  });
  vm.runInContext(bookmarkSource, context);
  vm.runInContext(commandSource, context);
  const commands = vm.runInContext("commands", context);
  // cd and aliases recurse through term.command when they redirect.
  term.command = vi.fn((line) => {
    const [name, ...args] = line.split(" ");
    return commands[name](args);
  });
  return { commands, location, storage, term };
}

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
});

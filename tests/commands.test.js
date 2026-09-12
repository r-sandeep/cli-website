import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const commandSource = readFileSync("config/commands.js", "utf8");
const jobsContext = vm.createContext({ module: { exports: {} } });
vm.runInContext(`${readFileSync("config/jobs.js", "utf8")}\nthis.productionJobs = jobs;`, jobsContext);
const productionJobs = jobsContext.productionJobs;
const testJobs = { ...productionJobs, 2: ["Platform Engineer"] };
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
  const term = {
    cwd,
    user,
    stylePrint: vi.fn(),
    writeln: vi.fn(),
    printArt: vi.fn(),
    openURL: vi.fn(),
    displayURL: vi.fn(),
    cols: 100,
  };
  const context = vm.createContext({
    term,
    jobs: productionJobs,
    firm: { blurb: "", email: "hello@example.com" },
    team,
    help: helpContext.helpEntries,
    shortcuts: helpContext.shortcutEntries,
    portfolio: {},
    colorText: (text) => text,
    window: {},
  });
  vm.runInContext(commandSource, context);
  const commands = vm.runInContext("commands", context);
  // cd recurses through term.command for the paths that resolve via another cd.
  term.command = vi.fn((line) => {
    const [name, ...args] = line.split(" ");
    return commands[name](args);
  });
  return { commands, term };
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
});

describe("terminal editing documentation", () => {
  const expectedShortcuts = [
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

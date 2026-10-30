import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const environments = [];

function createRecordingTerm() {
  const term = {
    VERSION: 4,
    _core: { buffer: { x: 0 } },
    cols: 80,
    currentLine: "",
    focus: vi.fn(),
    history: [],
    loadAddon: vi.fn(),
    open: vi.fn(),
    reset: vi.fn(),
    scrollToBottom: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
  };
  term.attachCustomKeyEventHandler = vi.fn((handler) => {
    term._customKeyHandler = handler;
  });
  term.onData = vi.fn((handler) => {
    term._onData = handler;
    return { dispose: vi.fn() };
  });
  return term;
}

function seedStorage(window, entries) {
  for (const [name, value] of entries) window.localStorage.setItem(name, value);
}

function storageSnapshot(window) {
  return Array.from({ length: window.localStorage.length }, (_, index) => {
    const name = window.localStorage.key(index);
    return [name, window.localStorage.getItem(name)];
  }).sort(([left], [right]) => left.localeCompare(right));
}

function loadProductionTerminal(storageEntries = []) {
  const term = createRecordingTerm();
  const env = createBrowserEnv({
    html: "<!doctype html><html><head></head><body><div id=\"files-all\"></div></body></html>",
    globals: {
      LOGO_TYPE: "ROOT",
      buildInfo: Object.freeze({ version: "1.2.3-test", buildDate: "2030-04-05" }),
      colorText: (text) => `\x1b[31m${text}\x1b[0m`,
      ensureASCIIArt: vi.fn(() => Promise.resolve()),
      ensureFileLoaded: vi.fn(() => Promise.resolve()),
      fitAddon: { fit: vi.fn() },
      getASCIIArtIdForCommand: vi.fn(() => null),
      getArt: vi.fn(() => ""),
      getPreloadFileForCommand: vi.fn(() => null),
      help: {},
      jobs: {},
      portfolio: {},
      preloadASCIIArt: vi.fn(() => Promise.resolve()),
      scheduleIdleTask: vi.fn((task) => task()),
      term,
    },
  });
  environments.push(env);
  seedStorage(env.window, storageEntries);
  env.loadScripts([
    "config/firm.js",
    "config/team.js",
    "js/bookmarks.js",
    "config/fs.js",
    "js/pipeline.js",
    "config/commands.js",
    "js/terminal-ext.js",
    "js/terminal.js",
  ]);
  const { commands, extend, runRootTerminal } = env.exportValues([
    "commands",
    "extend",
    "runRootTerminal",
  ]);
  extend(term);
  return { commands, env, runRootTerminal, term };
}

async function execute(term, line) {
  return term.executeCommandLine(line, {
    promptAfter: false,
    showLeadingNewline: false,
  });
}

function outputLines(mock) {
  return mock.mock.calls.map(([line]) => line);
}

function pressTab(term) {
  const preventDefault = vi.fn();
  const handled = term._customKeyHandler({
    altKey: false,
    ctrlKey: false,
    key: "Tab",
    metaKey: false,
    preventDefault,
    shiftKey: false,
    type: "keydown",
  });
  expect(handled).toBe(false);
  expect(preventDefault).toHaveBeenCalledOnce();
}

afterEach(() => {
  vi.restoreAllMocks();
  while (environments.length) environments.pop().cleanup();
});

describe("production output redirection", () => {
  it("flows through real replace, append, readback, pipeline, quote, alias, and ANSI capture paths", async () => {
    const { term } = loadProductionTerminal();
    term.tmpFiles.write("/tmp/sentinel-a", "~", "A\n");
    term.tmpFiles.write("/tmp/sentinel-b", "~", "B\n");

    term.write.mockClear();
    term.writeln.mockClear();
    await execute(term, "echo FIRST > /tmp/a");
    expect(term.write).not.toHaveBeenCalled();
    expect(term.writeln).not.toHaveBeenCalled();
    expect(term.tmpFiles.read("/tmp/a", "~").content).toBe("FIRST\n");

    await execute(term, "echo SECOND >> /tmp/a");
    expect(term.write).not.toHaveBeenCalled();
    expect(term.writeln).not.toHaveBeenCalled();
    expect(term.tmpFiles.read("/tmp/a", "~").content).toBe("FIRST\nSECOND\n");

    term.write.mockClear();
    await execute(term, "cat /tmp/a");
    expect(outputLines(term.write)).toEqual(["FIRST\r\nSECOND\r\n"]);

    term.writeln.mockClear();
    await execute(term, "cat /tmp/a | grep SECOND | wc -l");
    expect(outputLines(term.writeln)).toEqual(["1"]);

    term.writeln.mockClear();
    await execute(term, "whois root | grep -i root > /tmp/root.txt");
    expect(term.writeln).not.toHaveBeenCalled();
    const whois = term.tmpFiles.read("/tmp/root.txt", "~").content;
    expect(whois).toMatch(/^Root Ventures/);
    expect(whois.endsWith("\n")).toBe(true);
    expect(whois).not.toMatch(/[\u001b\u009b]/);
    expect(whois.trimEnd().split("\n").every((line) => /root/i.test(line))).toBe(true);

    term.defineAlias("w", "whois");
    term.environment.set("TARGET", "/tmp/expanded.txt");
    await execute(term, "w root | grep -i root > $TARGET");
    expect(term.tmpFiles.read("/tmp/expanded.txt", "~").content).toBe(whois);

    term.writeln.mockClear();
    await execute(term, `echo "a > b"`);
    await execute(term, `echo 'c >> d'`);
    expect(outputLines(term.writeln)).toEqual(["a > b", "c >> d"]);
    expect(term.tmpFiles.snapshot()).toEqual([
      ["a", "FIRST\nSECOND\n"],
      ["expanded.txt", whois],
      ["root.txt", whois],
      ["sentinel-a", "A\n"],
      ["sentinel-b", "B\n"],
    ]);
  });

  it("rejects each grammar error before preload or real cd dispatch and remains usable", async () => {
    const { commands, term } = loadProductionTerminal();
    term.tmpFiles.write("/tmp/alpha", "~", "A\n");
    term.tmpFiles.write("/tmp/beta", "~", "B\n");
    const before = term.tmpFiles.snapshot();
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const command = vi.spyOn(term, "command");
    const cd = vi.spyOn(commands, "cd");
    const cases = [
      ["cd /tmp >", "redirect: a command and target are required"],
      ["cd /tmp >>", "redirect: a command and target are required"],
      ["cd /tmp > /tmp/a > /tmp/b", "redirect: only one redirection is allowed"],
      ["cd /tmp > /tmp/a >> /tmp/b", "redirect: only one redirection is allowed"],
      ["cd /tmp > /tmp/a | grep tmp", "redirect: redirection must be the final operation"],
      ["cd /tmp > /tmp/a extra", "redirect: exactly one target word is required"],
    ];

    for (const [line, diagnostic] of cases) {
      preload.mockClear();
      command.mockClear();
      cd.mockClear();
      term.writeln.mockClear();
      await execute(term, line);
      expect(outputLines(term.writeln)).toEqual([diagnostic]);
      expect(preload).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(cd).not.toHaveBeenCalled();
      expect(term.cwd).toBe("~");
      expect(term.tmpFiles.snapshot()).toEqual(before);
    }

    await execute(term, "cd /tmp > /tmp/valid");
    expect(cd).toHaveBeenCalledOnce();
    expect(term.cwd).toBe("tmp");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["alpha", "A\n"],
      ["beta", "B\n"],
      ["valid", ""],
    ]);
  });

  it("refuses each outside or invalid target before production dispatch with a complete unchanged store", async () => {
    const { commands, term } = loadProductionTerminal();
    term.tmpFiles.write("/tmp/alpha", "~", "A\n");
    term.tmpFiles.write("/tmp/beta", "~", "B\n");
    const before = term.tmpFiles.snapshot();
    const preload = vi.spyOn(term, "preloadCommandAssets");
    const command = vi.spyOn(term, "command");
    const cd = vi.spyOn(commands, "cd");
    const cases = [
      ["README.md", "redirect: outside /tmp: README.md"],
      ["welcome.htm", "redirect: outside /tmp: welcome.htm"],
      ["/tmp", "redirect: outside /tmp: /tmp"],
      ["/bin", "redirect: outside /tmp: /bin"],
      ["/tmp/a/b", "redirect: invalid /tmp file name: /tmp/a/b"],
      ["/tmp/../a", "redirect: invalid /tmp file name: /tmp/../a"],
      ["/tmp/.", "redirect: invalid /tmp file name: /tmp/."],
      ["/tmp/..", "redirect: invalid /tmp file name: /tmp/.."],
      [`"/tmp/has space"`, "redirect: invalid /tmp file name: /tmp/has space"],
      ["/tmp/bad?name", "redirect: invalid /tmp file name: /tmp/bad?name"],
      ["/tmp/é", "redirect: invalid /tmp file name: /tmp/é"],
      [
        `/tmp/${"a".repeat(65)}`,
        `redirect: invalid /tmp file name:\r\n/tmp/${"a".repeat(65)}`,
      ],
    ];

    for (const [target, diagnostic] of cases) {
      preload.mockClear();
      command.mockClear();
      cd.mockClear();
      term.writeln.mockClear();
      await execute(term, `cd /tmp > ${target}`);
      expect(outputLines(term.writeln)).toEqual([diagnostic]);
      expect(preload).not.toHaveBeenCalled();
      expect(command).not.toHaveBeenCalled();
      expect(cd).not.toHaveBeenCalled();
      expect(term.cwd).toBe("~");
      expect(term.tmpFiles.snapshot()).toEqual(before);
    }

    await execute(term, "echo OK > /tmp/after-refusal");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["after-refusal", "OK\n"],
      ["alpha", "A\n"],
      ["beta", "B\n"],
    ]);
  });

  it("keeps expanded destinations bound to the entry directory across cwd-changing producers", async () => {
    const { term } = loadProductionTerminal();
    const originalWrite = term.write;
    const originalWriteln = term.writeln;
    term.cwd = "tmp";
    term.tmpFiles.write("out", "tmp", "OLD\n");
    term.tmpFiles.write("sentinel", "tmp", "kept\n");

    await execute(term, "cd ~ > out");
    expect(term.cwd).toBe("~");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["out", ""],
      ["sentinel", "kept\n"],
    ]);

    term.writeln.mockClear();
    await execute(term, "echo NEXT");
    expect(outputLines(term.writeln)).toEqual(["NEXT"]);
    expect(term.write).toBe(originalWrite);
    expect(term.writeln).toBe(originalWriteln);

    await execute(term, "cd /tmp");
    term.tmpFiles.write("out", "tmp", "OLD\n");
    await execute(term, "cd ~ >> ./out");
    expect(term.cwd).toBe("~");
    expect(term.tmpFiles.read("/tmp/out", "~").content).toBe("OLD\n");

    await execute(term, "cd /tmp");
    await execute(term, "cd ~ > /tmp/absolute");
    expect(term.tmpFiles.read("/tmp/absolute", "~").content).toBe("");

    await execute(term, "cd /tmp");
    term.environment.set("DEST", "./environment");
    await execute(term, "cd ~ > $DEST");
    expect(term.tmpFiles.read("/tmp/environment", "~").content).toBe("");

    await execute(term, "cd /tmp");
    term.defineAlias("home", "cd ~");
    await execute(term, "home > ./alias");
    expect(term.tmpFiles.read("/tmp/alias", "~").content).toBe("");

    await execute(term, "cd /tmp");
    await execute(term, "cd ~ | wc -l > ./count");
    expect(term.cwd).toBe("~");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["absolute", ""],
      ["alias", ""],
      ["count", "0\n"],
      ["environment", ""],
      ["out", "OLD\n"],
      ["sentinel", "kept\n"],
    ]);
  });

  it("keeps empty, pipeline-error, file-count, and Unicode character-limit writes atomic", async () => {
    const { term } = loadProductionTerminal();
    term.tmpFiles.write("/tmp/existing", "~", "OLD\n");

    await execute(term, "echo absent | grep present >> /tmp/existing");
    expect(term.tmpFiles.snapshot()).toEqual([["existing", "OLD\n"]]);
    await execute(term, "echo absent | grep present >> /tmp/missing");
    expect(term.tmpFiles.snapshot()).toEqual([["existing", "OLD\n"]]);
    await execute(term, "echo absent | grep present > /tmp/existing");
    expect(term.tmpFiles.snapshot()).toEqual([["existing", ""]]);
    await execute(term, "echo absent | grep present > /tmp/created");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["created", ""],
      ["existing", ""],
    ]);

    term.tmpFiles.write("/tmp/target", "~", "SAFE\n");
    const beforeErrors = term.tmpFiles.snapshot();
    term.writeln.mockClear();
    await execute(term, "echo producer | grep -x producer > /tmp/target");
    expect(outputLines(term.writeln)).toEqual(["grep: supported flags are -i, -v, and -n"]);
    expect(term.tmpFiles.snapshot()).toEqual(beforeErrors);
    term.writeln.mockClear();
    await execute(term, "echo producer | mystery > /tmp/target");
    expect(outputLines(term.writeln)).toEqual(["Unknown pipeline filter: mystery"]);
    expect(term.tmpFiles.snapshot()).toEqual(beforeErrors);

    term.tmpFiles.restore(Array.from({ length: 15 }, (_, index) => [`f${index}`, `${index}\n`]));
    await execute(term, "echo SIXTEENTH > /tmp/fifteen");
    expect(term.tmpFiles.snapshot()).toHaveLength(16);
    const fullStore = term.tmpFiles.snapshot();
    term.writeln.mockClear();
    await execute(term, "echo NO > /tmp/seventeen");
    expect(outputLines(term.writeln)).toEqual(["redirect: /tmp file limit (16) exceeded"]);
    expect(term.tmpFiles.snapshot()).toEqual(fullStore);
    await execute(term, "echo REPLACED > /tmp/f0");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["f0", "REPLACED\n"],
      ...fullStore.slice(1),
    ]);

    const exactSource = "😀".repeat(32767);
    term.tmpFiles.restore([
      ["sentinel", "kept\n"],
      ["source", exactSource],
    ]);
    await execute(term, "cat /tmp/source > /tmp/full");
    expect(Array.from(term.tmpFiles.read("/tmp/full", "~").content)).toHaveLength(32768);
    const exactStore = term.tmpFiles.snapshot();
    term.writeln.mockClear();
    await execute(term, "echo X >> /tmp/full");
    expect(outputLines(term.writeln)).toEqual(["redirect: full exceeds 32768 characters"]);
    expect(term.tmpFiles.snapshot()).toEqual(exactStore);

    term.tmpFiles.restore([
      ["sentinel", "kept\n"],
      ["source", "😀".repeat(32768)],
    ]);
    const beforeOversizedReplace = term.tmpFiles.snapshot();
    term.writeln.mockClear();
    await execute(term, "cat /tmp/source > /tmp/sentinel");
    expect(outputLines(term.writeln)).toEqual(["redirect: sentinel exceeds 32768 characters"]);
    expect(term.tmpFiles.snapshot()).toEqual(beforeOversizedReplace);
  });

  it("composes tmp commands, real Tab handlers, replay, deletion, and fresh-session storage isolation", async () => {
    const seeded = [
      ["rootvc.aliases", JSON.stringify([["w", "whois"]])],
      ["rootvc.bookmarks.v1", JSON.stringify([["saved", "~"]])],
      ["rootvc.cli.environment.v1", JSON.stringify({ version: 1, variables: [["KEEP", "value"]] })],
      ["unrelated", "untouched"],
    ];
    const { env, runRootTerminal, term } = loadProductionTerminal(seeded);
    const storageBefore = storageSnapshot(env.window);

    await execute(term, "echo A > /tmp/a.txt");
    await execute(term, "echo ALPHA > /tmp/alpha.txt");
    await execute(term, "echo Z > /tmp/z.txt");
    await execute(term, "cd /tmp");
    term.writeln.mockClear();
    await execute(term, "ls");
    expect(outputLines(term.writeln)).toEqual(["a.txt   alpha.txt   z.txt"]);

    for (const command of ["cat", "head", "tail", "less", "more"]) {
      term.write.mockClear();
      await execute(term, `${command} a.txt`);
      expect(outputLines(term.write)).toEqual(["A\r\n"]);
    }

    await execute(term, "cd ..");
    expect(term.cwd).toBe("/");
    term.writeln.mockClear();
    await execute(term, "ls");
    expect(outputLines(term.writeln)).toEqual(["bin   home   tmp"]);
    await execute(term, "cd tmp");
    expect(term.cwd).toBe("tmp");

    const originalInit = term.init;
    term.init = vi.fn();
    term.prompt = vi.fn();
    term.runDeepLink = vi.fn();
    term._initialized = false;
    runRootTerminal(term);
    for (const command of ["cat", "head", "tail", "less", "more", "rm"]) {
      term.setCurrentLine(`${command} z`);
      pressTab(term);
      expect(term.currentLine).toBe(`${command} z.txt `);
    }

    term.writeln.mockClear();
    await execute(term, "rm z.txt");
    expect(term.writeln).not.toHaveBeenCalled();
    expect(term.tmpFiles.snapshot()).toEqual([
      ["a.txt", "A\n"],
      ["alpha.txt", "ALPHA\n"],
    ]);
    term.setCurrentLine("rm z");
    pressTab(term);
    expect(term.currentLine).toBe("rm z");
    term.writeln.mockClear();
    await execute(term, "rm z.txt");
    expect(outputLines(term.writeln)).toEqual(["rm: z.txt: No such file or directory"]);

    await execute(term, "cd ~");
    const beforeOutsideRm = term.tmpFiles.snapshot();
    term.writeln.mockClear();
    await execute(term, "rm README.md");
    expect(outputLines(term.writeln)).toEqual(["I'm sorry Dave, I'm afraid I can't do that."]);
    expect(term.tmpFiles.snapshot()).toEqual(beforeOutsideRm);
    await execute(term, "cd /tmp");

    term.init = originalInit;
    term.runDeepLink = vi.fn(() => Promise.resolve());
    const beforeReplay = term.tmpFiles.snapshot();
    await term.resizeListener();
    expect(term.tmpFiles.snapshot()).toEqual(beforeReplay);
    await term.resizeListener();
    expect(term.tmpFiles.snapshot()).toEqual(beforeReplay);
    await execute(term, "echo NEXT >> a.txt");
    expect(term.tmpFiles.snapshot()).toEqual([
      ["a.txt", "A\nNEXT\n"],
      ["alpha.txt", "ALPHA\n"],
    ]);
    term.write.mockClear();
    await execute(term, "cat a.txt");
    expect(outputLines(term.write)).toEqual(["A\r\nNEXT\r\n"]);
    expect(storageSnapshot(env.window)).toEqual(storageBefore);

    const fresh = loadProductionTerminal(seeded);
    expect(fresh.term.tmpFiles.snapshot()).toEqual([]);
    expect(storageSnapshot(fresh.env.window)).toEqual(storageBefore);
  });
});

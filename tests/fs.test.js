import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadFs(globals = {}) {
  env = createBrowserEnv({
    html: `
      <!doctype html>
      <html>
        <head></head>
        <body>
          <div id="files-all"></div>
        </body>
      </html>
    `,
    globals: {
      fetch: vi.fn(async () => ({
        text: async () => "remote body",
      })),
      team: { lee: { name: "Lee" } },
      ...globals,
    },
  });
  env.loadScripts(["config/fs.js"]);
  return env.exportValues([
    "_insertFileToDOM",
    "_loadFile",
    "ensureFileLoaded",
    "getFileContents",
    "getPreloadFileForCommand",
    "createTmpFileStore",
    "_DIRS",
  ]);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("virtual fs", () => {
  it("deduplicates concurrent remote file loads", async () => {
    const { _loadFile } = loadFs();

    const first = _loadFile("README.md");
    const second = _loadFile("README.md");

    expect(first).toBe(second);

    await Promise.all([first, second]);

    expect(env.window.fetch).toHaveBeenCalledTimes(1);
    expect(env.document.getElementById("README.md")).not.toBeNull();
  });

  it("loads local files synchronously without fetching", async () => {
    const { ensureFileLoaded, getFileContents } = loadFs();

    await ensureFileLoaded("id_rsa");

    expect(env.window.fetch).not.toHaveBeenCalled();
    expect(getFileContents("id_rsa")).toBe("Nice try!");
  });

  it("reuses existing DOM nodes when inserting file contents", () => {
    const { _insertFileToDOM } = loadFs();

    _insertFileToDOM("README.md", "first");
    _insertFileToDOM("README.md", "second");

    expect(env.document.querySelectorAll("#README\\.md")).toHaveLength(1);
    expect(env.document.getElementById("README.md").innerText).toBe("second");
  });

  it("preloads only remote files for cat and grep", () => {
    const { getPreloadFileForCommand } = loadFs();

    expect(getPreloadFileForCommand("cat", ["README.md"])).toBe("README.md");
    expect(getPreloadFileForCommand("grep", ["welcome.htm"])).toBe(
      "welcome.htm"
    );
    expect(getPreloadFileForCommand("cat", ["id_rsa"])).toBeNull();
    expect(getPreloadFileForCommand("open", ["README.md"])).toBeNull();
  });

  it("returns a loading message for remote files that have not landed yet", () => {
    const { getFileContents } = loadFs();

    expect(getFileContents("README.md")).toBe(
      "Loading README.md. Try again in a moment."
    );
    expect(env.window.fetch).toHaveBeenCalledTimes(1);
  });

  it("adds tmp to the static directory model without storing tmp files there", () => {
    const { _DIRS, createTmpFileStore } = loadFs();

    expect(_DIRS["/"]).toEqual(["bin", "home", "tmp"]);
    expect(_DIRS.tmp).toEqual([]);
    expect(createTmpFileStore().list()).toEqual([]);
  });

  it("accepts only exact direct-child tmp target spellings and names", () => {
    const { createTmpFileStore } = loadFs();
    const store = createTmpFileStore([["sentinel", "kept"]]);
    const validNames = [
      "a",
      "a".repeat(64),
      "dots.are-ok",
      "under_score",
      "dash-name",
      "constructor",
      "__proto__",
    ];

    for (const name of validNames) {
      const absolute = createTmpFileStore();
      expect(absolute.write(`/tmp/${name}`, "~", name)).toMatchObject({ ok: true, name });
      expect(absolute.read(`/tmp/${name}`, "~")).toMatchObject({ ok: true, content: name });

      const relative = createTmpFileStore();
      expect(relative.write(name, "tmp", name)).toMatchObject({ ok: true, name });
      const dotted = createTmpFileStore();
      expect(dotted.write(`./${name}`, "tmp", name)).toMatchObject({ ok: true, name });
    }

    const rejected = [
      ["README.md", "~"], ["welcome.htm", "~"], ["/tmp", "~"],
      ["/bin", "~"], ["/tmp/a/b", "~"], ["/tmp/../a", "~"],
      ["../a", "tmp"], ["a", "~"], ["", "tmp"], [".", "tmp"],
      ["..", "tmp"], ["bad name", "tmp"], ["é", "tmp"],
      ["bad!", "tmp"], ["a".repeat(65), "tmp"],
    ];

    for (const [target, cwd] of rejected) {
      const before = store.snapshot();
      const result = store.write(target, cwd, "changed");
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^redirect:/);
      expect(store.snapshot()).toEqual(before);
    }
  });

  it("enforces file-count and final-content boundaries atomically", () => {
    const { createTmpFileStore } = loadFs();
    const fifteen = Array.from({ length: 15 }, (_, i) => [`f${i}`, "x"]);
    const store = createTmpFileStore(fifteen);

    expect(store.write("/tmp/sixteenth", "~", "x")).toMatchObject({ ok: true });
    const full = store.snapshot();
    expect(store.write("/tmp/seventeenth", "~", "x")).toMatchObject({
      ok: false,
      code: "file-limit",
    });
    expect(store.snapshot()).toEqual(full);

    expect(store.write("/tmp/f0", "~", "r")).toMatchObject({ ok: true });
    expect(store.list()).toHaveLength(16);
    expect(store.remove("/tmp/f1", "~")).toMatchObject({ ok: true });
    expect(store.write("/tmp/replacement", "~", "x")).toMatchObject({ ok: true });

    const contentStore = createTmpFileStore([["edge", "x".repeat(32767)]]);
    expect(contentStore.write("/tmp/edge", "~", "y", true)).toMatchObject({ ok: true });
    expect(contentStore.read("/tmp/edge", "~").content).toHaveLength(32768);
    const beforeAppendOverflow = contentStore.snapshot();
    expect(contentStore.write("/tmp/edge", "~", "z", true)).toMatchObject({
      ok: false,
      code: "character-limit",
    });
    expect(contentStore.snapshot()).toEqual(beforeAppendOverflow);

    const beforeReplaceOverflow = contentStore.snapshot();
    expect(contentStore.write("/tmp/edge", "~", "z".repeat(32769))).toMatchObject({
      ok: false,
      code: "character-limit",
    });
    expect(contentStore.snapshot()).toEqual(beforeReplaceOverflow);
  });

  it("counts astral and unpaired Unicode as characters at the content boundary", () => {
    const { createTmpFileStore } = loadFs();
    const store = createTmpFileStore();
    const astral = "😀";
    const belowFormerUtf16Limit = astral.repeat(16385);

    expect(store.write("/tmp/unicode", "~", belowFormerUtf16Limit)).toMatchObject({
      ok: true,
    });
    expect(store.read("/tmp/unicode", "~").content).toBe(belowFormerUtf16Limit);

    const toExactLimit = astral.repeat(16383);
    expect(store.write("/tmp/unicode", "~", toExactLimit, true)).toMatchObject({
      ok: true,
    });
    expect(Array.from(store.read("/tmp/unicode", "~").content)).toHaveLength(32768);

    const exactBoundary = store.snapshot();
    expect(store.write("/tmp/unicode", "~", astral, true)).toMatchObject({
      ok: false,
      code: "character-limit",
    });
    expect(store.snapshot()).toEqual(exactBoundary);

    expect(store.write("/tmp/unicode", "~", astral.repeat(32769))).toMatchObject({
      ok: false,
      code: "character-limit",
    });
    expect(store.snapshot()).toEqual(exactBoundary);

    const mixedStore = createTmpFileStore();
    const exactMixedBoundary = `${astral.repeat(16384)}${"x".repeat(16384)}`;
    expect(Array.from(exactMixedBoundary)).toHaveLength(32768);
    expect(mixedStore.write("/tmp/mixed", "~", exactMixedBoundary)).toMatchObject({
      ok: true,
    });
    const mixedBoundarySnapshot = mixedStore.snapshot();
    expect(mixedStore.write("/tmp/mixed", "~", "\ud800", true)).toMatchObject({
      ok: false,
      code: "character-limit",
    });
    expect(mixedStore.write("/tmp/mixed", "~", "\udc00", true)).toMatchObject({
      ok: false,
      code: "character-limit",
    });
    expect(mixedStore.snapshot()).toEqual(mixedBoundarySnapshot);
  });

  it("preserves exact text for replace, append, and empty-output rules", () => {
    const { createTmpFileStore } = loadFs();
    const store = createTmpFileStore();

    expect(store.write("/tmp/a", "~", "first\n\nlast\n")).toMatchObject({ ok: true });
    expect(store.read("/tmp/a", "~").content).toBe("first\n\nlast\n");
    expect(store.write("/tmp/a", "~", "next\n", true)).toMatchObject({ ok: true });
    expect(store.read("/tmp/a", "~").content).toBe("first\n\nlast\nnext\n");

    expect(store.write("/tmp/a", "~", "")).toMatchObject({ ok: true });
    expect(store.read("/tmp/a", "~").content).toBe("");
    expect(store.write("/tmp/a", "~", "unchanged")).toMatchObject({ ok: true });
    expect(store.write("/tmp/a", "~", "", true)).toMatchObject({ ok: true, unchanged: true });
    expect(store.read("/tmp/a", "~").content).toBe("unchanged");
    expect(store.write("/tmp/missing", "~", "", true)).toMatchObject({ ok: true, unchanged: true });
    expect(store.list()).not.toContain("missing");
  });
});

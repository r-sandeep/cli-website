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
    "resolveSessionDirectory",
    "getSessionFileNames",
    "hasSessionFile",
    "getSessionFileLines",
    "writeSessionFile",
    "_snapshotSessionFiles",
    "_withSessionFileView",
    "getVisibleBuiltInEntryType",
  ]);
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("virtual fs", () => {
  it("deduplicates concurrent remote file loads and fetches from this origin", async () => {
    const { _loadFile } = loadFs();

    const first = _loadFile("README.md");
    const second = _loadFile("README.md");

    expect(first).toBe(second);

    await Promise.all([first, second]);

    expect(env.window.fetch).toHaveBeenCalledTimes(1);
    // Used to hit raw.githubusercontent.com, a cross-origin dependency whose
    // `main` branch need not match the deployed build.
    expect(env.window.fetch).toHaveBeenCalledWith("/README.md");
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

  it("resolves effective directories to canonical keys and rejects ambiguous direct access", () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      resolveSessionDirectory,
      writeSessionFile,
    } = loadFs();

    expect(resolveSessionDirectory("~", "guest")).toBe("/home/guest");
    expect(resolveSessionDirectory("~", "root")).toBe("/home/root");
    expect(resolveSessionDirectory("bin", "guest")).toBe("/bin");
    expect(resolveSessionDirectory("bin", "root")).toBe("/bin");
    expect(resolveSessionDirectory("home", "guest")).toBe("/home");
    expect(resolveSessionDirectory("/", "root")).toBe("/");

    const guestRows = ["guest", "", '<tag> & "quoted"'];
    const rootRows = ["root"];
    writeSessionFile("/home/guest", "same", guestRows);
    writeSessionFile("/home/guest", "later", ["ordered"]);
    writeSessionFile("/home/root", "same", rootRows);
    guestRows[0] = "outside mutation";
    rootRows[0] = "outside mutation";

    const guestSnapshot = getSessionFileLines("/home/guest", "same");
    guestSnapshot[0] = "returned mutation";
    expect(getSessionFileLines("/home/guest", "same")).toEqual([
      "guest", "", '<tag> & "quoted"',
    ]);
    expect(getSessionFileLines("/home/root", "same")).toEqual(["root"]);
    expect(writeSessionFile("/home/guest", "same", ["append"], true)).toEqual([
      "guest", "", '<tag> & "quoted"', "append",
    ]);
    expect(writeSessionFile("/home/guest", "same", ["replacement"])).toEqual([
      "replacement",
    ]);
    expect(getSessionFileNames("/home/guest")).toEqual(["same", "later"]);
    expect(getSessionFileNames("/home/root")).toEqual(["same"]);

    expect(() => getSessionFileNames("~")).toThrow(/canonical/);
    expect(() => writeSessionFile("~", "leak", ["no"])).toThrow(/canonical/);
    expect(() => resolveSessionDirectory("~", "spoofed")).toThrow(/guest or root/);
  });

  it("stores exact line arrays by directory in creation order", () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      hasSessionFile,
      writeSessionFile,
    } = loadFs();
    const specialLines = ["first", "", 'a \\"quote\\"', "<", ">", "&", "&amp;"];

    expect(writeSessionFile("/home/guest", "n", specialLines)).toEqual(specialLines);
    specialLines[0] = "mutated outside";
    expect(writeSessionFile("/home/guest", "constructor", ["constructor"])).toEqual([
      "constructor",
    ]);
    expect(writeSessionFile("/home/guest", "__proto__", ["prototype"])).toEqual([
      "prototype",
    ]);
    expect(writeSessionFile("/bin", "n", ["other directory"])).toEqual([
      "other directory",
    ]);

    expect(getSessionFileNames("/home/guest")).toEqual(["n", "constructor", "__proto__"]);
    expect(getSessionFileNames("/bin")).toEqual(["n"]);
    expect(getSessionFileLines("/home/guest", "n")).toEqual([
      "first", "", 'a \\"quote\\"', "<", ">", "&", "&amp;",
    ]);
    expect(getSessionFileLines("/bin", "n")).toEqual(["other directory"]);
    expect(hasSessionFile("/home/guest", "constructor")).toBe(true);
    expect(hasSessionFile("/home/guest", "missing")).toBe(false);
  });

  it("appends and replaces without moving files or conflating empty and missing", () => {
    const {
      getSessionFileLines,
      getSessionFileNames,
      hasSessionFile,
      writeSessionFile,
    } = loadFs();

    writeSessionFile("/home/guest", "n", ["one", ""]);
    writeSessionFile("/home/guest", "later", ["second"]);
    expect(writeSessionFile("/home/guest", "n", ["two"], true)).toEqual([
      "one", "", "two",
    ]);
    expect(writeSessionFile("/home/guest", "n", ["replacement"])).toEqual([
      "replacement",
    ]);
    expect(getSessionFileNames("/home/guest")).toEqual(["n", "later"]);

    expect(writeSessionFile("/home/guest", "n", [], true)).toEqual(["replacement"]);
    expect(writeSessionFile("/home/guest", "empty-append", [], true)).toEqual([]);
    expect(writeSessionFile("/home/guest", "empty-replace", [])).toEqual([]);
    expect(hasSessionFile("/home/guest", "empty-append")).toBe(true);
    expect(hasSessionFile("/home/guest", "empty-replace")).toBe(true);
    expect(getSessionFileLines("/home/guest", "empty-append")).toEqual([]);
    expect(getSessionFileLines("/home/guest", "missing")).toBeNull();
    expect(getSessionFileNames("/home/guest")).toEqual([
      "n", "later", "empty-append", "empty-replace",
    ]);
  });

  it("classifies visible built-in targets without treating session files as built-ins", () => {
    const { getVisibleBuiltInEntryType, writeSessionFile } = loadFs();

    expect(getVisibleBuiltInEntryType("~", "id_rsa", "guest")).toBe("file");
    expect(getVisibleBuiltInEntryType("~", "welcome.htm", "guest")).toBe("file");
    expect(getVisibleBuiltInEntryType("~", "README.md", "guest")).toBeNull();
    expect(getVisibleBuiltInEntryType("~", "README.md", "root")).toBe("file");
    expect(getVisibleBuiltInEntryType("/", "bin", "guest")).toBe("directory");
    expect(getVisibleBuiltInEntryType("home", "lee", "guest")).toBe("directory");
    expect(getVisibleBuiltInEntryType("bin", "zsh", "guest")).toBe("file");

    writeSessionFile("/home/guest", "notes.txt", ["writable"]);
    expect(getVisibleBuiltInEntryType("~", "notes.txt", "guest")).toBeNull();
  });

  it("serves detached scoped snapshots and restores live files after success or failure", async () => {
    const {
      _snapshotSessionFiles,
      _withSessionFileView,
      getSessionFileLines,
      getSessionFileNames,
      writeSessionFile,
    } = loadFs();
    writeSessionFile("/home/guest", "n", ["first", "", "<&>"]);
    writeSessionFile("/home/root", "n", ["root"]);
    const snapshot = _snapshotSessionFiles();
    writeSessionFile("/home/guest", "n", ["later"]);
    writeSessionFile("/home/guest", "new", ["live"]);

    await _withSessionFileView(snapshot, async () => {
      expect(getSessionFileNames("/home/guest")).toEqual(["n"]);
      expect(getSessionFileLines("/home/guest", "n")).toEqual(["first", "", "<&>"]);
      expect(getSessionFileLines("/home/root", "n")).toEqual(["root"]);
      const rows = getSessionFileLines("/home/guest", "n");
      rows[0] = "mutated return";
      expect(getSessionFileLines("/home/guest", "n")[0]).toBe("first");
    });
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["later"]);
    expect(getSessionFileNames("/home/guest")).toEqual(["n", "new"]);

    await expect(_withSessionFileView(snapshot, async () => {
      throw new Error("replay failed");
    })).rejects.toThrow("replay failed");
    expect(getSessionFileLines("/home/guest", "n")).toEqual(["later"]);
  });
});

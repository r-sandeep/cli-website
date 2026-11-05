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
    "_DIRS",
    "_FILES",
    "_insertFileToDOM",
    "_loadFile",
    "ensureFileLoaded",
    "getFileContents",
    "getPreloadFileForCommand",
    "getSessionFileNames",
    "getSessionFileLines",
    "hasSessionFile",
    "writeSessionFile",
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
    expect(getPreloadFileForCommand("grep", ["needle", "README.md"])).toBe(
      "README.md"
    );
    expect(getPreloadFileForCommand("cat", ["id_rsa"])).toBeNull();
    expect(getPreloadFileForCommand("open", ["README.md"])).toBeNull();
  });

  it("keeps ordered defensive line arrays isolated by directory for one page", () => {
    const {
      _DIRS,
      _FILES,
      getSessionFileLines,
      getSessionFileNames,
      hasSessionFile,
      writeSessionFile,
    } = loadFs();
    const builtInsBefore = JSON.stringify({ dirs: _DIRS, files: _FILES });
    const original = ["A", "", '<x> & "q"'];

    writeSessionFile("~", "notes", original);
    original[0] = "mutated caller";
    writeSessionFile("/", "notes", ["other"]);
    writeSessionFile("~", "next", ["second"]);
    writeSessionFile("~", "__proto__", ["safe"]);
    writeSessionFile("~", "notes", ["replacement"]);
    writeSessionFile("~", "notes", ["tail", ""], true);
    writeSessionFile("~", "notes", [], true);

    expect(getSessionFileNames("~")).toEqual(["notes", "next", "__proto__"]);
    expect(getSessionFileNames("/")).toEqual(["notes"]);
    expect(getSessionFileLines("~", "notes")).toEqual(["replacement", "tail", ""]);
    expect(getSessionFileLines("/", "notes")).toEqual(["other"]);
    expect(hasSessionFile("~", "__proto__")).toBe(true);
    expect(getSessionFileLines("bin", "notes")).toBeNull();

    const copy = getSessionFileLines("~", "notes");
    copy[0] = "mutated read";
    expect(getSessionFileLines("~", "notes")).toEqual(["replacement", "tail", ""]);
    expect(JSON.stringify({ dirs: _DIRS, files: _FILES })).toBe(builtInsBefore);
  });

  it("keeps display-identical home directories isolated by user identity", () => {
    const { getSessionFileLines, getSessionFileNames, writeSessionFile } = loadFs();

    writeSessionFile("~", "notes", ["guest home"], false, "guest");
    writeSessionFile("~", "notes", ["root home"], false, "root");
    writeSessionFile("~", "guest-only", ["private"], false, "guest");
    writeSessionFile("~", "root-only", ["private"], false, "root");

    expect(getSessionFileNames("~", "guest")).toEqual(["notes", "guest-only"]);
    expect(getSessionFileNames("~", "root")).toEqual(["notes", "root-only"]);
    expect(getSessionFileLines("~", "notes", "guest")).toEqual(["guest home"]);
    expect(getSessionFileLines("~", "notes", "root")).toEqual(["root home"]);
    expect(getSessionFileLines("~", "root-only", "guest")).toBeNull();
    expect(getSessionFileLines("~", "guest-only", "root")).toBeNull();
  });

  it("distinguishes an empty file from a file containing one blank row", () => {
    const { getSessionFileLines, writeSessionFile } = loadFs();

    writeSessionFile("~", "empty", []);
    writeSessionFile("~", "blank", [""]);

    expect(getSessionFileLines("~", "empty")).toEqual([]);
    expect(getSessionFileLines("~", "blank")).toEqual([""]);
  });

  it("does not persist session files or use storage or network", () => {
    const first = loadFs();
    const storage = env.window.localStorage;
    const getItem = vi.spyOn(storage, "getItem");
    const setItem = vi.spyOn(storage, "setItem");
    const removeItem = vi.spyOn(storage, "removeItem");
    first.writeSessionFile("~", "notes", ["memory only"]);

    expect(first.getSessionFileLines("~", "notes")).toEqual(["memory only"]);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(env.window.fetch).not.toHaveBeenCalled();

    env.cleanup();
    env = null;
    const fresh = loadFs();
    expect(fresh.getSessionFileNames("~")).toEqual([]);
  });

  it("skips remote loading when the current directory has a same-name session file", async () => {
    const term = { cwd: "~" };
    const {
      _loadFile,
      ensureFileLoaded,
      getPreloadFileForCommand,
      writeSessionFile,
    } = loadFs({ term });
    writeSessionFile("~", "README.md", ["local session"]);

    expect(getPreloadFileForCommand("cat", ["README.md"])).toBeNull();
    expect(getPreloadFileForCommand("grep", ["needle", "README.md"])).toBeNull();
    await ensureFileLoaded("README.md");
    await _loadFile("README.md");
    expect(env.window.fetch).not.toHaveBeenCalled();

    term.cwd = "/";
    expect(getPreloadFileForCommand("cat", ["README.md"])).toBe("README.md");
    await ensureFileLoaded("README.md");
    expect(env.window.fetch).toHaveBeenCalledTimes(1);
  });

  it("returns a loading message for remote files that have not landed yet", () => {
    const { getFileContents } = loadFs();

    expect(getFileContents("README.md")).toBe(
      "Loading README.md. Try again in a moment."
    );
    expect(env.window.fetch).toHaveBeenCalledTimes(1);
  });
});

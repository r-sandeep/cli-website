// fs.js — Virtual file system for the Root Ventures terminal.
//
// Since there's no real file system in the browser, files are stored as hidden
// <div> elements in the DOM (inside #files-all). Content is written to
// div.innerText on load and read back via div.innerHTML when accessed —
// the browser's HTML entity encoding/decoding is what necessitates the
// replaceAll() calls in getFileContents().
//
// Remote files (README.md, welcome.htm) are fetched from this origin the first
// time a command needs them and inserted into the DOM the same way. Local
// files are inserted directly.

// Files with hardcoded content that don't need to be fetched.
const _LOCAL_FILES = {
  "id_rsa": "Nice try!",
};

// Files fetched on demand. The key is used as the DOM element ID. Both are
// served from dist/ (the build copies README.md there), so they match the
// deployed commit and need no cross-origin request to GitHub.
const _REMOTE_FILES = {
  "README.md": "/README.md",
  "welcome.htm": "/welcome.htm",
};

// Combined map of all known files (used by `find`).
const _FILES = {
  ..._LOCAL_FILES,
  ..._REMOTE_FILES,
}

// Directory structure. "home" is populated dynamically from team.js so we
// don't have to update it when team members are added or removed.
const _DIRS = {
  "~": ["id_rsa", "welcome.htm", "README.md"],
  "bin": ["zsh"],
  "home": Object.keys(team).concat("guest", "root").sort(),
  "/": ["bin", "home"],
};

// Pre-compute absolute paths for every known file, used by `find`.
let _FULL_PATHS = {};
let _LOADING_FILES = {};

// Files created during this page session stay in memory, grouped by the cwd in
// which they were written. Maps preserve creation order and safely accept file
// names such as "__proto__" without sharing state with the built-in maps.
let _SESSION_FILES = new Map();

function _sessionDirectoryKey(directory, user = "guest") {
  if (directory !== "~") return directory;
  // `~` is only a display path: resolve it through the shell's closed user set
  // so an arbitrary caller-supplied identity cannot create or select a home
  // scope, and guest/root can never alias the same session-file directory.
  return user === "root" ? "/root" : "/home/guest";
}

function _sessionFilesForDirectory(directory, create = false, user = "guest") {
  const key = _sessionDirectoryKey(directory, user);
  let files = _SESSION_FILES.get(key);
  if (!files && create) {
    files = new Map();
    _SESSION_FILES.set(key, files);
  }
  return files;
}

function getSessionFileNames(directory, user = "guest") {
  const files = _sessionFilesForDirectory(directory, false, user);
  return files ? Array.from(files.keys()) : [];
}

function hasSessionFile(directory, name, user = "guest") {
  const files = _sessionFilesForDirectory(directory, false, user);
  return files ? files.has(name) : false;
}

function getSessionFileLines(directory, name, user = "guest") {
  const files = _sessionFilesForDirectory(directory, false, user);
  if (!files || !files.has(name)) return null;
  return files.get(name).slice();
}

function writeSessionFile(directory, name, lines, append = false, user = "guest") {
  const files = _sessionFilesForDirectory(directory, true, user);
  const incoming = Array.from(lines);
  const contents = append && files.has(name)
    ? files.get(name).concat(incoming)
    : incoming;
  files.set(name, contents);
  return contents.slice();
}

// Returns why a visible built-in entry cannot be replaced by a session file.
// Hidden entries (README.md for guest) remain legal session targets, and an
// existing session file is intentionally not a conflict because it may be
// overwritten or appended.
function getSessionFileTargetConflict(directory, name, user = "guest") {
  const entries = _DIRS[directory] || [];
  const visible = entries.includes(name) &&
    (name !== "README.md" || user === "root");
  if (!visible) return null;
  return Object.prototype.hasOwnProperty.call(_DIRS, name)
    ? "directory"
    : "built-in file";
}

// Resize redraw reconstructs terminal output by replaying history. Rebuild
// session files in an isolated store so historical > and >> operations render
// normally without overwriting or appending to the page's live files.
async function withIsolatedSessionFiles(replay) {
  const liveFiles = _SESSION_FILES;
  _SESSION_FILES = new Map();
  try {
    return await replay();
  } finally {
    _SESSION_FILES = liveFiles;
  }
}
for (const [key, values] of Object.entries(_DIRS)) {
  for (const value of values) {
    switch (key) {
      case "~":
        _FULL_PATHS[value] = `${key}/${value}`;
        break;
      case "/":
        _FULL_PATHS[value] = `/${value}`;
        break;
      default:
        _FULL_PATHS[value] = `/${key}/${value}`;
    }
  }
}

// Called at terminal init to populate the DOM with the inline files. Remote
// files are not fetched here: `cat`/`grep` await ensureFileLoaded first, so
// fetching them for every visitor only paid for the rare visitor who reads them.
function preloadFiles() {
  for (const [name, content] of Object.entries(_LOCAL_FILES)) {
    _insertFileToDOM(name, content);
  }
}

// Fetches a remote file and inserts it into the DOM when ready.
function _loadFile(name) {
  if (
    typeof term !== "undefined" &&
    hasSessionFile(term.cwd, name, term.user)
  ) {
    return Promise.resolve();
  }

  if (document.getElementById(name)) {
    return Promise.resolve();
  }

  if (_LOADING_FILES[name]) {
    return _LOADING_FILES[name];
  }

  _LOADING_FILES[name] = fetch(_REMOTE_FILES[name])
    .then(response => response.text())
    .then((body) => _insertFileToDOM(name, body))
    .finally(() => {
      delete _LOADING_FILES[name];
    });

  return _LOADING_FILES[name];
}

function ensureFileLoaded(name) {
  if (
    typeof term !== "undefined" &&
    hasSessionFile(term.cwd, name, term.user)
  ) {
    return Promise.resolve();
  }

  if (!_FILES[name]) {
    return Promise.resolve();
  }

  if (document.getElementById(name)) {
    return Promise.resolve();
  }

  if (_REMOTE_FILES[name]) {
    return _loadFile(name);
  }

  if (_LOCAL_FILES[name]) {
    _insertFileToDOM(name, _LOCAL_FILES[name]);
  }

  return Promise.resolve();
}

function getPreloadFileForCommand(cmd, args) {
  const filename = cmd === "grep" ? (args[1] || args[0]) : args[0];
  if (!filename) {
    return null;
  }

  if (
    ["cat", "grep"].includes(cmd) &&
    _REMOTE_FILES[filename] &&
    !(typeof term !== "undefined" && hasSessionFile(term.cwd, filename, term.user))
  ) {
    return filename;
  }

  return null;
}

// Stores file content as the innerText of a <div id="{name}"> inside #files-all.
// innerText is used (vs innerHTML) so the content is treated as plain text and
// won't be interpreted as HTML markup.
function _insertFileToDOM(name, txt) {
  const parentDiv = document.getElementById("files-all");
  let div = document.getElementById(name);

  if (!div) {
    div = document.createElement("div");
    div.id = name;
    parentDiv.appendChild(div);
  }
  div.innerText = txt;
  return txt;
}

// Retrieves file content from the DOM. We read innerHTML (not innerText) because
// the browser HTML-encodes the plain text when it was written — innerHTML gives
// us the encoded form, which we then manually decode back to the original chars.
function getFileContents(filename) {
  const div = document.getElementById(filename);
  if (!div) {
    if (_REMOTE_FILES[filename]) {
      _loadFile(filename);
      return `Loading ${filename}. Try again in a moment.`;
    }

    return `File not found: ${filename}`;
  }

  return div.innerHTML
    .replaceAll("<br>", "\r\n")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<");
}

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

// Writable files live only in this JavaScript Map. Keeping them separate from
// the DOM-backed built-ins avoids changing built-in serialization and ensures
// a page reload starts with a fresh store.
const _SESSION_FILES = new Map();
let _SESSION_FILE_VIEW = null;
const _SESSION_DIRECTORY_KEYS = new Set([
  "/",
  "/bin",
  "/home",
  "/home/guest",
  "/home/root",
]);

// Session storage uses explicit absolute identities even though the terminal's
// established cwd labels remain compact (notably "~" for either user's home).
function resolveSessionDirectory(cwd, user) {
  switch (cwd) {
    case "~":
      if (user !== "guest" && user !== "root") {
        throw new TypeError("A guest or root user is required to resolve ~");
      }
      return `/home/${user}`;
    case "bin":
      return "/bin";
    case "home":
      return "/home";
    case "/":
      return "/";
    default:
      throw new TypeError(`Unknown session directory: ${cwd}`);
  }
}

function _sessionDirectory(directory, create = false) {
  if (!_SESSION_DIRECTORY_KEYS.has(directory)) {
    throw new TypeError(`Session directory key must be canonical: ${directory}`);
  }
  const store = _SESSION_FILE_VIEW || _SESSION_FILES;
  if (!store.has(directory) && create) {
    store.set(directory, new Map());
  }
  return store.get(directory);
}

// History replay reads from a detached, page-memory-only view. The live store
// is never replaced, and nested/failed replays restore the previous view.
function _snapshotSessionFiles() {
  return new Map(
    Array.from(_SESSION_FILES, ([directory, files]) => [
      directory,
      new Map(Array.from(files, ([name, lines]) => [name, [...lines]])),
    ])
  );
}

async function _withSessionFileView(snapshot, operation) {
  const previousView = _SESSION_FILE_VIEW;
  _SESSION_FILE_VIEW = new Map(
    Array.from(snapshot, ([directory, files]) => [
      directory,
      new Map(Array.from(files, ([name, lines]) => [name, [...lines]])),
    ])
  );
  try {
    return await operation();
  } finally {
    _SESSION_FILE_VIEW = previousView;
  }
}

function getSessionFileNames(directory) {
  const files = _sessionDirectory(directory);
  return files ? Array.from(files.keys()) : [];
}

function hasSessionFile(directory, filename) {
  const files = _sessionDirectory(directory);
  return Boolean(files && files.has(filename));
}

function getSessionFileLines(directory, filename) {
  const files = _sessionDirectory(directory);
  if (!files || !files.has(filename)) return null;
  return [...files.get(filename)];
}

function writeSessionFile(directory, filename, lines, append = false) {
  if (!Array.isArray(lines)) {
    throw new TypeError("Session file contents must be an array of lines");
  }

  const files = _sessionDirectory(directory, true);
  const nextLines = lines.map((line) => String(line));
  if (append && files.has(filename)) {
    files.set(filename, [...files.get(filename), ...nextLines]);
  } else {
    files.set(filename, nextLines);
  }
  return [...files.get(filename)];
}

// Reports only immutable entries visible to this user. Session files are
// deliberately excluded so callers can distinguish a writable existing file
// from a built-in collision before executing a command.
function getVisibleBuiltInEntryType(directory, filename, user = "guest") {
  const entries = _DIRS[directory] || [];
  const visible = entries.includes(filename) &&
    (filename !== "README.md" || user === "root");
  if (!visible) return null;
  if (directory === "/" || directory === "home") return "directory";
  return "file";
}

// Pre-compute absolute paths for every known file, used by `find`.
let _FULL_PATHS = {};
let _LOADING_FILES = {};
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
  const filename = args[0];
  if (!filename) {
    return null;
  }

  if (["cat", "grep"].includes(cmd) && _REMOTE_FILES[filename]) {
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

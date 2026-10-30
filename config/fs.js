// fs.js — Virtual file system for the Root Ventures terminal.
//
// Since there's no real file system in the browser, files are stored as hidden
// <div> elements in the DOM (inside #files-all). Content is written to
// div.innerText on load and read back via div.innerHTML when accessed —
// the browser's HTML entity encoding/decoding is what necessitates the
// replaceAll() calls in getFileContents().
//
// Remote files (README.md, welcome.htm) are fetched from GitHub on first load
// and inserted into the DOM the same way. Local files are inserted directly.

// Files with hardcoded content that don't need to be fetched.
const _LOCAL_FILES = {
  "id_rsa": "Nice try!",
};

// Files fetched from GitHub at startup. The key is used as the DOM element ID.
const _REMOTE_FILES = {
  "README.md": "https://raw.githubusercontent.com/rootvc/cli-website/main/README.md",
  "welcome.htm": "https://raw.githubusercontent.com/rootvc/cli-website/main/welcome.htm",
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
  "tmp": [],
  "/": ["bin", "home", "tmp"],
};

// Writable files are deliberately separate from the static DOM-backed files
// above. A new store is attached to each terminal by extend(), so /tmp survives
// ordinary redraws and init calls but is never shared or persisted.
const _TMP_FILE_LIMIT = 16;
const _TMP_CHARACTER_LIMIT = 32768;
const _TMP_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function exceedsTmpCharacterLimit(content) {
  // JavaScript string iteration advances by Unicode code point: a valid
  // surrogate pair counts once, while an unpaired surrogate counts by itself.
  // Keep the check bounded and allocation-free for large captured output.
  // UTF-16 length is a safe lower bound on code-point count, so common output
  // at or below the limit can avoid iteration without changing Unicode rules.
  if (content.length <= _TMP_CHARACTER_LIMIT) return false;

  let remaining = _TMP_CHARACTER_LIMIT;
  for (const _character of content) {
    if (remaining === 0) return true;
    remaining -= 1;
  }
  return false;
}

function createTmpFileStore(initialEntries = []) {
  let files = new Map(initialEntries);

  const compareNames = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const snapshot = () =>
    Array.from(files.entries())
      .sort(([left], [right]) => compareNames(left, right))
      .map(([name, content]) => [name, content]);

  const resolve = (target, cwd) => {
    const value = typeof target === "string" ? target : "";
    let name = null;

    if (value.startsWith("/tmp/")) {
      name = value.slice(5);
    } else if (cwd === "tmp" && value.startsWith("./")) {
      name = value.slice(2);
    } else if (cwd === "tmp" && !value.includes("/")) {
      name = value;
    } else {
      return {
        ok: false,
        code: "outside-tmp",
        message: `redirect: outside /tmp: ${value}`,
      };
    }

    if (
      name === "." ||
      name === ".." ||
      !_TMP_NAME_PATTERN.test(name)
    ) {
      return {
        ok: false,
        code: "invalid-name",
        message: `redirect: invalid /tmp file name: ${value}`,
      };
    }

    return { ok: true, name };
  };

  const write = (target, cwd, content, append = false) => {
    const resolved = resolve(target, cwd);
    if (!resolved.ok) return resolved;

    const text = String(content);
    const exists = files.has(resolved.name);

    // Appending no captured lines is a true no-op, including for a missing
    // target. This is intentionally checked before the file-count limit.
    if (append && text.length === 0) {
      return { ok: true, name: resolved.name, unchanged: true };
    }

    if (!exists && files.size >= _TMP_FILE_LIMIT) {
      return {
        ok: false,
        code: "file-limit",
        message: `redirect: /tmp file limit (${_TMP_FILE_LIMIT}) exceeded`,
      };
    }

    const nextContent = append && exists ? files.get(resolved.name) + text : text;
    // Count Unicode code points rather than UTF-16 code units so astral
    // characters consume one character of the documented limit. Stop as soon
    // as the limit is exceeded instead of allocating an array for the output.
    if (exceedsTmpCharacterLimit(nextContent)) {
      return {
        ok: false,
        code: "character-limit",
        message: `redirect: ${resolved.name} exceeds ${_TMP_CHARACTER_LIMIT} characters`,
      };
    }

    files.set(resolved.name, nextContent);
    return { ok: true, name: resolved.name };
  };

  const read = (target, cwd) => {
    const resolved = resolve(target, cwd);
    if (!resolved.ok) return resolved;
    if (!files.has(resolved.name)) {
      return { ok: false, code: "not-found", name: resolved.name };
    }
    return { ok: true, name: resolved.name, content: files.get(resolved.name) };
  };

  const remove = (target, cwd) => {
    const resolved = resolve(target, cwd);
    if (!resolved.ok) return resolved;
    if (!files.delete(resolved.name)) {
      return { ok: false, code: "not-found", name: resolved.name };
    }
    return { ok: true, name: resolved.name };
  };

  const restore = (entries) => {
    files = new Map(entries);
  };

  return Object.freeze({
    list: () => snapshot().map(([name]) => name),
    read,
    remove,
    resolve,
    restore,
    snapshot,
    write,
  });
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

// Called at terminal init to populate the DOM with file content.
function preloadFiles() {
  for (const name of Object.keys(_REMOTE_FILES)) {
    _loadFile(name);
  }

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

const BOOKMARK_STORAGE_KEY = "rootvc.bookmarks.v1";
const BOOKMARK_LIMIT = 25;
const BOOKMARK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function _defaultBookmarkStorage() {
  try {
    return localStorage;
  } catch (_) {
    return null;
  }
}

function createBookmarkStore(storage) {
  let activeStorage = storage;
  let bookmarks = null;

  try {
    if (!activeStorage) activeStorage = _defaultBookmarkStorage();
    bookmarks = _parseBookmarks(activeStorage.getItem(BOOKMARK_STORAGE_KEY));
  } catch (_) {
    // Keep failed loads distinct from a valid empty store. No operation may
    // overwrite data that could not be completely read and validated.
  }

  function persist(nextBookmarks) {
    try {
      activeStorage.setItem(BOOKMARK_STORAGE_KEY, JSON.stringify(nextBookmarks));
      bookmarks = nextBookmarks;
      return true;
    } catch (_) {
      return false;
    }
  }

  return Object.freeze({
    add(name, path) {
      if (!_validBookmarkName(name)) return { ok: false, error: "invalid-name" };
      if (bookmarks === null) return { ok: false, error: "storage" };
      if (bookmarks.some(([savedName]) => savedName === name)) {
        return { ok: false, error: "duplicate" };
      }
      if (bookmarks.length === BOOKMARK_LIMIT) {
        return { ok: false, error: "limit" };
      }
      if (typeof path !== "string") return { ok: false, error: "invalid-path" };

      const nextBookmarks = [...bookmarks, [name, path]];
      return persist(nextBookmarks)
        ? { ok: true }
        : { ok: false, error: "storage" };
    },

    exportBackup() {
      if (bookmarks === null) return { ok: false, error: "storage" };

      const entries = bookmarks
        .map(([name, path]) => ({ name, path }))
        .sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0
        );
      return {
        ok: true,
        json: JSON.stringify({ version: 1, bookmarks: entries }),
      };
    },

    importBackup(serialized, options = {}) {
      if (bookmarks === null) return { ok: false, error: "storage" };

      const { mode, dryRun = false } = options;
      if ((mode !== "merge" && mode !== "replace") || typeof dryRun !== "boolean") {
        return { ok: false, error: "invalid-options" };
      }

      let imported;
      try {
        imported = _parseBookmarkBackup(serialized);
      } catch (error) {
        return { ok: false, error: error.message };
      }

      const currentByName = new Map(bookmarks);
      let nextBookmarks;
      if (mode === "merge") {
        nextBookmarks = bookmarks.map(([name, path]) => [name, path]);
        for (const [name, path] of imported) {
          if (currentByName.has(name)) {
            if (currentByName.get(name) !== path) {
              return { ok: false, error: "conflict" };
            }
          } else {
            nextBookmarks.push([name, path]);
          }
        }
      } else {
        nextBookmarks = imported;
      }

      if (nextBookmarks.length > BOOKMARK_LIMIT) {
        return { ok: false, error: "limit" };
      }

      const counts = _bookmarkChangeCounts(bookmarks, nextBookmarks);
      const result = { ok: true, ...counts };
      const changed = counts.added > 0 || counts.updated > 0 || counts.removed > 0;
      if (dryRun || !changed) return result;

      return persist(nextBookmarks)
        ? result
        : { ok: false, error: "storage" };
    },

    list() {
      if (bookmarks === null) return { ok: false, error: "storage" };

      return {
        ok: true,
        entries: bookmarks
          .map(([name, path]) => ({ name, path }))
          .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0
          ),
      };
    },

    lookup(name) {
      if (!_validBookmarkName(name)) return { ok: false, error: "invalid-name" };
      if (bookmarks === null) return { ok: false, error: "storage" };

      const found = bookmarks.find(([savedName]) => savedName === name);
      return found
        ? { ok: true, path: found[1] }
        : { ok: false, error: "not-found" };
    },

    remove(name) {
      if (!_validBookmarkName(name)) return { ok: false, error: "invalid-name" };
      if (bookmarks === null) return { ok: false, error: "storage" };

      const index = bookmarks.findIndex(([savedName]) => savedName === name);
      if (index === -1) return { ok: false, error: "not-found" };

      const nextBookmarks = bookmarks.filter((_, entryIndex) => entryIndex !== index);
      return persist(nextBookmarks)
        ? { ok: true }
        : { ok: false, error: "storage" };
    },
  });
}

function _validBookmarkName(name) {
  return typeof name === "string" && BOOKMARK_NAME_PATTERN.test(name);
}

function _bookmarkChangeCounts(currentBookmarks, nextBookmarks) {
  const currentByName = new Map(currentBookmarks);
  const nextByName = new Map(nextBookmarks);
  const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };

  for (const [name, path] of nextByName) {
    if (!currentByName.has(name)) counts.added += 1;
    else if (currentByName.get(name) === path) counts.unchanged += 1;
    else counts.updated += 1;
  }
  for (const [name] of currentByName) {
    if (!nextByName.has(name)) counts.removed += 1;
  }

  return counts;
}

function _parseBookmarkBackup(serialized) {
  if (typeof serialized !== "string") throw new Error("malformed-json");

  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch (_) {
    throw new Error("malformed-json");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid-backup");
  }
  if (parsed.version !== 1) throw new Error("unsupported-version");
  if (!Array.isArray(parsed.bookmarks)) throw new Error("invalid-backup");

  const names = new Set();
  return parsed.bookmarks.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("invalid-backup");
    }
    if (!_validBookmarkName(entry.name)) throw new Error("invalid-name");
    if (typeof entry.path !== "string") throw new Error("invalid-backup");
    if (names.has(entry.name)) throw new Error("duplicate");
    names.add(entry.name);
    return [entry.name, entry.path];
  });
}

function _parseBookmarks(serialized) {
  if (serialized === null) return [];

  const parsed = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.length > BOOKMARK_LIMIT) {
    throw new Error("Invalid bookmark data");
  }

  const names = new Set();
  return parsed.map((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !_validBookmarkName(entry[0]) ||
      typeof entry[1] !== "string" ||
      names.has(entry[0])
    ) {
      throw new Error("Invalid bookmark data");
    }
    names.add(entry[0]);
    return [entry[0], entry[1]];
  });
}

const bookmarkStore = createBookmarkStore();
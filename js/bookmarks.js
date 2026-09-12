const BOOKMARK_STORAGE_KEY = "rootvc.bookmarks.v1";
const BOOKMARK_LIMIT = 25;
const BOOKMARK_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function createBookmarkStore(storage) {
  let activeStorage = storage;
  let bookmarks = null;

  try {
    if (!activeStorage) activeStorage = localStorage;
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
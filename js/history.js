const HISTORY_STORAGE_KEY = "rootvc.history";
const HISTORY_LIMIT = 1000;

function _defaultHistoryStorage() {
  try {
    return localStorage;
  } catch (_) {
    return null;
  }
}

function _parseHistory(serialized) {
  if (serialized === null) return [];

  const parsed = JSON.parse(serialized);
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error("Invalid history data");
  }

  return parsed.slice(-HISTORY_LIMIT);
}

function createHistoryStore(storage) {
  const suppliedStorage = arguments.length > 0;
  let activeStorage = storage;
  let history = [];
  let quarantined = false;
  let persistenceError = null;

  function resolveStorage() {
    if (!suppliedStorage) activeStorage = _defaultHistoryStorage();
    return activeStorage;
  }

  const initialStorage = resolveStorage();
  if (!initialStorage) {
    quarantined = true;
    persistenceError = "unavailable";
  } else {
    try {
      history = _parseHistory(initialStorage.getItem(HISTORY_STORAGE_KEY));
    } catch (_) {
      // An unreadable payload must not be repaired by a later append. Session
      // history remains available, but only an explicit successful clear can
      // prove that it is safe to write this feature's key again.
      quarantined = true;
      persistenceError = "read";
    }
  }

  function result(durable, error = null, extra = {}) {
    return { ok: true, durable, error, ...extra };
  }

  return Object.freeze({
    entries() {
      return history.slice();
    },

    status() {
      return {
        durable: persistenceError === null && !quarantined,
        error: persistenceError,
        quarantined,
      };
    },

    append(line) {
      if (typeof line !== "string" || line.trim() === "") {
        return result(persistenceError === null && !quarantined, persistenceError, {
          added: false,
        });
      }

      history = [...history, line].slice(-HISTORY_LIMIT);
      if (quarantined) {
        return result(false, persistenceError || "read", { added: true });
      }

      try {
        const availableStorage = resolveStorage();
        if (!availableStorage) throw new Error("History storage unavailable");
        availableStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
        persistenceError = null;
        return result(true, null, { added: true });
      } catch (_) {
        persistenceError = "write";
        return result(false, "write", { added: true });
      }
    },

    clear() {
      history = [];

      try {
        const availableStorage = resolveStorage();
        if (!availableStorage) throw new Error("History storage unavailable");
        availableStorage.removeItem(HISTORY_STORAGE_KEY);
        quarantined = false;
        persistenceError = null;
        return result(true);
      } catch (_) {
        // Memory clear is still successful, but saved or unreadable bytes may
        // remain. Keep the write quarantine until removal actually succeeds.
        quarantined = true;
        persistenceError = "clear";
        return result(false, "clear");
      }
    },
  });
}

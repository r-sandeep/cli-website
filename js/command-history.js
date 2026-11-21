// Browser-local command history. Storage failure must never prevent the
// terminal from falling back to its in-memory history.
const COMMAND_HISTORY_LIMIT = 200;
const COMMAND_HISTORY_RECORD_VERSION = 1;

function normalizeCommandHistoryRecord(record) {
  if (
    !record ||
    record.id !== "history" ||
    record.version !== COMMAND_HISTORY_RECORD_VERSION ||
    !Array.isArray(record.entries) ||
    !record.entries.every((entry) => typeof entry === "string")
  ) return null;
  return record.entries.slice(-COMMAND_HISTORY_LIMIT);
}

function createCommandHistoryStore(options = {}) {
  const databaseName = options.databaseName || "rootvc.command-history";
  const storeName = "snapshots";
  let disabled = false;
  let database = null;
  let opening = null;
  let appendQueue = Promise.resolve();

  function disablePersistence() {
    disabled = true;
    if (database) database.close();
    database = null;
  }

  function getIndexedDB() {
    if (Object.prototype.hasOwnProperty.call(options, "indexedDB")) {
      return options.indexedDB;
    }
    return globalThis.indexedDB;
  }

  function openDatabase() {
    if (disabled) return Promise.resolve(null);
    if (database) return Promise.resolve(database);
    if (opening) return opening;

    opening = new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = () => {
        disablePersistence();
        settle(null);
      };
      let request;
      try {
        const indexedDB = getIndexedDB();
        if (!indexedDB || typeof indexedDB.open !== "function") return fail();
        request = indexedDB.open(databaseName, 1);
      } catch (_error) {
        return fail();
      }
      request.onupgradeneeded = () => {
        try {
          const opened = request.result;
          if (!opened.objectStoreNames.contains(storeName)) {
            opened.createObjectStore(storeName, { keyPath: "id" });
          }
        } catch (_error) {
          fail();
        }
      };
      request.onerror = (event) => {
        event?.preventDefault?.();
        fail();
      };
      request.onblocked = fail;
      request.onsuccess = () => {
        const opened = request.result;
        if (disabled || settled) {
          opened.close();
          return;
        }
        database = opened;
        database.onversionchange = disablePersistence;
        settle(database);
      };
    });
    return opening;
  }

  async function load() {
    const opened = await openDatabase();
    if (!opened || disabled) return [];
    return new Promise((resolve) => {
      let result = [];
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const fail = () => {
        disablePersistence();
        settle([]);
      };
      try {
        const transaction = opened.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get("history");
        request.onsuccess = () => {
          if (request.result === undefined) return;
          const entries = normalizeCommandHistoryRecord(request.result);
          if (entries === null) {
            fail();
            try { transaction.abort(); } catch (_error) {}
            return;
          }
          result = entries;
        };
        request.onerror = fail;
        transaction.oncomplete = () => settle(result.slice());
        transaction.onerror = fail;
        transaction.onabort = fail;
      } catch (_error) {
        fail();
      }
    });
  }

  function appendOnce(command) {
    if (disabled) return Promise.resolve(null);
    return openDatabase().then((opened) => {
      if (!opened || disabled) return null;
      return new Promise((resolve) => {
        let nextEntries = null;
        let settled = false;
        const settle = (value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        const fail = () => {
          disablePersistence();
          settle(null);
        };
        try {
          const transaction = opened.transaction(storeName, "readwrite");
          const objectStore = transaction.objectStore(storeName);
          const request = objectStore.get("history");
          request.onsuccess = () => {
            let entries = [];
            if (request.result !== undefined) {
              entries = normalizeCommandHistoryRecord(request.result);
              if (entries === null) {
                fail();
                try { transaction.abort(); } catch (_error) {}
                return;
              }
            }
            nextEntries = entries.concat(command).slice(-COMMAND_HISTORY_LIMIT);
            try {
              objectStore.put({
                id: "history",
                version: COMMAND_HISTORY_RECORD_VERSION,
                entries: nextEntries,
              });
            } catch (_error) {
              fail();
              try { transaction.abort(); } catch (_abortError) {}
            }
          };
          request.onerror = fail;
          transaction.oncomplete = () =>
            settle(nextEntries === null ? null : nextEntries.slice());
          transaction.onerror = fail;
          transaction.onabort = fail;
        } catch (_error) {
          fail();
        }
      });
    });
  }

  function append(command) {
    if (typeof command !== "string" || command.length === 0) {
      return Promise.resolve(null);
    }
    const pending = appendQueue.then(
      () => appendOnce(command),
      () => appendOnce(command)
    );
    appendQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  return { append, load };
}
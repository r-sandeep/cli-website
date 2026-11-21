// Browser-local command history. Storage failure must never prevent the
// terminal from falling back to its in-memory history.
const COMMAND_HISTORY_LIMIT = 200;
const COMMAND_HISTORY_RECORD_VERSION = 1;
const COMMAND_HISTORY_OPERATION_TIMEOUT_MS = 1000;

function normalizeCommandHistoryRecord(record) {
  if (
    !record ||
    record.id !== "history" ||
    record.version !== COMMAND_HISTORY_RECORD_VERSION ||
    !Array.isArray(record.entries)
  ) return null;
  for (let index = 0; index < record.entries.length; index += 1) {
    if (
      !Object.prototype.hasOwnProperty.call(record.entries, index) ||
      typeof record.entries[index] !== "string"
    ) return null;
  }
  return record.entries.slice(-COMMAND_HISTORY_LIMIT);
}

function createCommandHistoryStore(options = {}) {
  const databaseName = options.databaseName || "rootvc.command-history";
  const storeName = "snapshots";
  let disabled = false;
  let database = null;
  let opening = null;
  let appendQueue = Promise.resolve();
  const activeOperations = new Set();

  function disablePersistence() {
    if (disabled) return;
    disabled = true;
    if (opening) opening.settle(null);
    if (database) database.close();
    database = null;
    for (const operation of [...activeOperations]) operation.cancel();
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
    if (opening) return opening.promise;

    let resolveOpening;
    const state = {
      settled: false,
      promise: new Promise((resolve) => { resolveOpening = resolve; }),
      settle(value) {
        if (state.settled) return;
        state.settled = true;
        if (opening === state) opening = null;
        resolveOpening(value);
      },
    };
    opening = state;

    const fail = () => disablePersistence();
    let request;
    try {
      const indexedDB = getIndexedDB();
      if (!indexedDB || typeof indexedDB.open !== "function") {
        fail();
        return state.promise;
      }
      request = indexedDB.open(databaseName, 1);
    } catch (_error) {
      fail();
      return state.promise;
    }

    request.onupgradeneeded = () => {
      if (disabled || state.settled) {
        try { request.transaction?.abort(); } catch (_error) {}
        return;
      }
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
      if (disabled || state.settled) {
        opened.close();
        return;
      }
      database = opened;
      database.onversionchange = disablePersistence;
      state.settle(database);
    };
    return state.promise;
  }

  function runBounded(fallback, work) {
    if (disabled) return Promise.resolve(fallback);
    return new Promise((resolve) => {
      const operation = {
        settled: false,
        transaction: null,
        timer: null,
        settle(value) {
          if (operation.settled) return;
          operation.settled = true;
          clearTimeout(operation.timer);
          activeOperations.delete(operation);
          resolve(value);
        },
        cancel() {
          if (operation.settled) return;
          try { operation.transaction?.abort(); } catch (_error) {}
          operation.settle(fallback);
        },
      };
      activeOperations.add(operation);
      operation.timer = setTimeout(
        disablePersistence,
        COMMAND_HISTORY_OPERATION_TIMEOUT_MS
      );

      openDatabase().then((opened) => {
        if (operation.settled) {
          if (opened && opened !== database) opened.close();
          return;
        }
        if (!opened || disabled) {
          disablePersistence();
          return;
        }
        try {
          work({
            opened,
            isActive: () => !operation.settled && !disabled,
            setTransaction: (transaction) => { operation.transaction = transaction; },
            succeed: operation.settle,
            fail: disablePersistence,
          });
        } catch (_error) {
          disablePersistence();
        }
      }, disablePersistence);
    });
  }

  function load() {
    return runBounded([], ({ opened, isActive, setTransaction, succeed, fail }) => {
      let result = [];
      const transaction = opened.transaction(storeName, "readonly");
      setTransaction(transaction);
      const request = transaction.objectStore(storeName).get("history");
      request.onsuccess = () => {
        if (!isActive() || request.result === undefined) return;
        const entries = normalizeCommandHistoryRecord(request.result);
        if (entries === null) {
          fail();
          try { transaction.abort(); } catch (_error) {}
          return;
        }
        result = entries;
      };
      request.onerror = fail;
      transaction.oncomplete = () => {
        if (isActive()) succeed(result.slice());
      };
      transaction.onerror = fail;
      transaction.onabort = fail;
    });
  }

  function appendOnce(command) {
    return runBounded(null, ({ opened, isActive, setTransaction, succeed, fail }) => {
      let nextEntries = null;
      const transaction = opened.transaction(storeName, "readwrite");
      setTransaction(transaction);
      const objectStore = transaction.objectStore(storeName);
      const request = objectStore.get("history");
      request.onsuccess = () => {
        if (!isActive()) return;
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
      transaction.oncomplete = () => {
        if (isActive()) succeed(nextEntries === null ? null : nextEntries.slice());
      };
      transaction.onerror = fail;
      transaction.onabort = fail;
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
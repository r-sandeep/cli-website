// history.js — Browser-local, bounded command history storage.
//
// The durable archive is one versioned record in a dedicated IndexedDB
// database. Each append reads and extends that record inside one read/write
// transaction, so separate tabs cannot overwrite one another with stale local
// snapshots. Local snapshots intentionally remain independent per visit.

const COMMAND_HISTORY_DATABASE = "rootvc.command-history";
const COMMAND_HISTORY_DATABASE_VERSION = 1;
const COMMAND_HISTORY_STORE = "state";
const COMMAND_HISTORY_KEY = "history";
const COMMAND_HISTORY_RECORD_VERSION = 1;
const COMMAND_HISTORY_LIMIT = 200;
const COMMAND_HISTORY_TIMEOUT_MS = 1000;
const COMMAND_HISTORY_INITIALIZATION_TIMEOUT_MS = 50;

const createCommandHistoryStore = (options = {}) => {
  const databaseName =
    typeof options.databaseName === "string" && options.databaseName.length > 0
      ? options.databaseName
      : COMMAND_HISTORY_DATABASE;
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
      ? options.timeoutMs
      : COMMAND_HISTORY_TIMEOUT_MS;

  const initializationTimeoutMs =
    Number.isFinite(options.initializationTimeoutMs) &&
    options.initializationTimeoutMs >= 0
      ? options.initializationTimeoutMs
      : Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0
        ? options.timeoutMs
        : COMMAND_HISTORY_INITIALIZATION_TIMEOUT_MS;

  let entries = [];
  let database = null;
  let durable = true;
  let resetGeneration = 0;
  let appendTail = Promise.resolve(false);

  const newest = (values) => values.slice(-COMMAND_HISTORY_LIMIT);
  const getSnapshot = () => entries.slice();

  const validRecord = (record) =>
    record !== null &&
    typeof record === "object" &&
    record.version === COMMAND_HISTORY_RECORD_VERSION &&
    Array.isArray(record.entries) &&
    record.entries.every(
      (entry) => typeof entry === "string" && entry.trim().length > 0
    );

  const closeDatabase = () => {
    if (database !== null) {
      try {
        database.close();
      } catch (error) {
        // Closing is best-effort after the instance has already fallen back.
      }
      database = null;
    }
  };

  const useMemoryOnly = () => {
    durable = false;
    closeDatabase();
  };

  const openDatabase = (initializationActive, registerCancel) =>
    new Promise((resolve) => {
      let settled = false;
      let request;

      const finish = (result) => {
        if (settled || !initializationActive()) {
          if (result !== null) {
            try {
              result.close();
            } catch (error) {
              // A late successful open is closed without affecting the visit.
            }
          }
          if (!settled) {
            settled = true;
            resolve(null);
          }
          return;
        }
        settled = true;
        resolve(result);
      };

      registerCancel(() => finish(null));

      try {
        const indexedDBFactory = Object.prototype.hasOwnProperty.call(
          options,
          "indexedDB"
        )
          ? options.indexedDB
          : window.indexedDB;
        if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") {
          finish(null);
          return;
        }
        request = indexedDBFactory.open(
          databaseName,
          COMMAND_HISTORY_DATABASE_VERSION
        );
      } catch (error) {
        finish(null);
        return;
      }

      request.onupgradeneeded = (event) => {
        try {
          if (!initializationActive() || event.oldVersion !== 0) {
            request.transaction.abort();
            return;
          }
          request.result.createObjectStore(COMMAND_HISTORY_STORE);
        } catch (error) {
          try {
            request.transaction.abort();
          } catch (abortError) {
            // The request error/timeout path below will settle initialization.
          }
        }
      };
      request.onblocked = () => finish(null);
      request.onerror = () => finish(null);
      request.onsuccess = () => {
        const opened = request.result;
        try {
          if (!opened.objectStoreNames.contains(COMMAND_HISTORY_STORE)) {
            finish(null);
            try {
              opened.close();
            } catch (error) {
              // The incompatible database is intentionally left untouched.
            }
            return;
          }
          finish(opened);
        } catch (error) {
          finish(null);
          try {
            opened.close();
          } catch (closeError) {
            // The incompatible database is intentionally left untouched.
          }
        }
      };
    });

  const runTransaction = (mode, operation) =>
    new Promise((resolve) => {
      if (!durable || database === null) {
        resolve(false);
        return;
      }

      let transaction;
      let settled = false;
      let timer;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      // Request handlers run after the operation callback has returned, so a
      // synchronous exception in one of them is not caught by the outer
      // transaction-construction try/catch. Give every handler the same
      // transaction-local failure path, and make late callbacks inert after a
      // timeout, abort, or earlier failure has settled the operation.
      const fail = () => {
        if (settled) return;
        if (transaction) {
          try {
            transaction.abort();
          } catch (error) {
            // The transaction may already be complete or aborted.
          }
        }
        finish(false);
      };
      const active = () => !settled;

      try {
        transaction = database.transaction(COMMAND_HISTORY_STORE, mode);
        transaction.oncomplete = () => finish(true);
        transaction.onerror = () => finish(false);
        transaction.onabort = () => finish(false);
        timer = setTimeout(fail, timeoutMs);
        operation(
          transaction.objectStore(COMMAND_HISTORY_STORE),
          transaction,
          fail,
          active
        );
      } catch (error) {
        fail();
      }
    });

  const initialResetGeneration = resetGeneration;
  let initializationActive = true;
  let initializationTransaction = null;
  let cancelOpen = () => {};
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const settleInitialization = () => {
    if (!initializationActive) return;
    initializationActive = false;
    clearTimeout(initializationTimer);
    resolveReady();
  };

  const abandonInitialization = () => {
    if (!initializationActive) return;
    initializationActive = false;
    cancelOpen();
    if (initializationTransaction !== null) {
      try {
        initializationTransaction.abort();
      } catch (error) {
        // The initialization transaction may already have settled.
      }
    }
    useMemoryOnly();
    resolveReady();
  };

  const initializationTimer = setTimeout(
    abandonInitialization,
    initializationTimeoutMs
  );

  (async () => {
    database = await openDatabase(
      () => initializationActive,
      (cancel) => {
        cancelOpen = cancel;
      }
    );
    if (!initializationActive) return;
    if (database === null) {
      useMemoryOnly();
      settleInitialization();
      return;
    }

    database.onversionchange = () => useMemoryOnly();

    let loaded = [];
    let loadedValidRecord = false;
    let incompatible = false;
    const restored = await runTransaction("readwrite", (store, transaction, fail, active) => {
      initializationTransaction = transaction;
      const request = store.get(COMMAND_HISTORY_KEY);
      request.onerror = fail;
      request.onsuccess = () => {
        if (!initializationActive || !active()) return;
        try {
          const record = request.result;
          if (record === undefined) {
            loaded = [];
            return;
          }
          if (!validRecord(record)) {
            incompatible = true;
            return;
          }

          loaded = newest(record.entries);
          loadedValidRecord = true;
          if (loaded.length !== record.entries.length) {
            const put = store.put(
              { version: COMMAND_HISTORY_RECORD_VERSION, entries: loaded },
              COMMAND_HISTORY_KEY
            );
            put.onerror = fail;
          }
        } catch (error) {
          fail();
        }
      };
    });
    initializationTransaction = null;
    if (!initializationActive) return;

    // A valid record remains useful visit memory even if its transactional
    // normalization could not commit (for example quota exhaustion). A visit
    // reset during opening is an ownership fence: late storage completion must
    // not refill the cleared local snapshot.
    if (
      loadedValidRecord &&
      resetGeneration === initialResetGeneration
    ) {
      entries = newest(loaded.concat(entries));
    }

    if (!restored || incompatible) {
      useMemoryOnly();
    }
    settleInitialization();
  })().catch(() => {
    if (!initializationActive) return;
    useMemoryOnly();
    settleInitialization();
  });

  const append = (entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return Promise.resolve(false);
    }

    // Memory is authoritative for the active visit, including while a durable
    // write is pending or after storage has failed. Preserve the exact accepted
    // submission; trimming is only the nonblank predicate.
    entries = newest(entries.concat(entry));

    const queuedAppend = appendTail.then(async () => {
      await ready;
      // Sticky availability is checked only when this delta reaches the head of
      // the instance-local queue, before any later transaction is constructed.
      if (!durable || database === null) return false;

      let incompatible = false;
      const committed = await runTransaction("readwrite", (store, transaction, fail, active) => {
        const get = store.get(COMMAND_HISTORY_KEY);
        get.onerror = fail;
        get.onsuccess = () => {
          if (!active()) return;
          try {
            const record = get.result;
            let durableEntries;
            if (record === undefined) {
              durableEntries = [];
            } else if (validRecord(record)) {
              durableEntries = record.entries;
            } else {
              incompatible = true;
              fail();
              return;
            }

            const put = store.put(
              {
                version: COMMAND_HISTORY_RECORD_VERSION,
                entries: newest(durableEntries.concat(entry)),
              },
              COMMAND_HISTORY_KEY
            );
            put.onerror = fail;
          } catch (error) {
            fail();
          }
        };
      });

      if (!committed || incompatible) {
        useMemoryOnly();
        return false;
      }
      return true;
    });

    appendTail = queuedAppend.catch(() => {
      useMemoryOnly();
      return false;
    });
    return appendTail;
  };

  const resetVisit = () => {
    resetGeneration += 1;
    entries = [];
  };

  return Object.freeze({
    append,
    getSnapshot,
    ready,
    resetVisit,
  });
};

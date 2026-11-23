(() => {
  "use strict";

  const output = document.querySelector("#store-results");
  const button = document.querySelector("#run-store");
  const prefix = `asd-history-${Date.now()}-${Math.random()}`;
  let counter = 0;

  const name = (label) => `${prefix}-${label}-${counter++}`;
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const equal = (actual, expected, message) => {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(expected);
    if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
  };
  const pass = (line) => {
    const row = document.createElement("div");
    row.textContent = line;
    output.appendChild(row);
  };

  const requestResult = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });

  const transactionDone = (transaction) =>
    new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = transaction.onerror = () =>
        reject(transaction.error || new Error("IndexedDB transaction failed"));
    });

  const deleteDatabase = (databaseName) =>
    new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`delete blocked: ${databaseName}`));
    });

  const seedRecord = async (databaseName, record, storeName = "state") => {
    await deleteDatabase(databaseName);
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    const database = await requestResult(request);
    if (record !== undefined) {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(record, "history");
      await transactionDone(transaction);
    }
    database.close();
  };

  const readRecord = async (databaseName) => {
    const database = await requestResult(indexedDB.open(databaseName, 1));
    const transaction = database.transaction("state", "readonly");
    const record = await requestResult(
      transaction.objectStore("state").get("history")
    );
    await transactionDone(transaction);
    database.close();
    return record;
  };

  const storeFor = (databaseName, options = {}) =>
    createCommandHistoryStore({
      databaseName,
      indexedDB,
      timeoutMs: 80,
      ...options,
    });

  const exactRetention = async () => {
    for (const size of [0, 1, 199, 200]) {
      const databaseName = name(`boundary-${size}`);
      const seeded = Array.from({ length: size }, (_, index) => `seed ${index}`);
      await seedRecord(databaseName, { version: 1, entries: seeded });
      const store = storeFor(databaseName);
      await store.ready;
      equal(store.getSnapshot(), seeded, `restore boundary ${size}`);
      await store.append("repeat command");
      await store.append("repeat command");
      const expected = seeded.concat("repeat command", "repeat command").slice(-200);
      equal(store.getSnapshot(), expected, `local boundary ${size}`);
      equal((await readRecord(databaseName)).entries, expected, `durable boundary ${size}`);
    }

    for (let run = 0; run < 2; run += 1) {
      const databaseName = name(`sequence-${run}`);
      const store = storeFor(databaseName);
      await store.ready;
      const submitted = [];
      for (let index = 0; index <= 201; index += 1) {
        const command = index === 101 ? "echo duplicate | cat" : `echo ${index}`;
        submitted.push(command);
        await store.append(command);
      }
      submitted.splice(150, 0, submitted[101]);
      await store.append(submitted[150]);
      const expected = submitted.slice(-200);
      equal(store.getSnapshot(), expected, `full local sequence ${run}`);
      equal((await readRecord(databaseName)).entries, expected, `full durable sequence ${run}`);
    }
  };

  const concurrentReset = async () => {
    for (const seedSize of [1, 199]) {
      const databaseName = name(`concurrent-${seedSize}`);
      const seed =
        seedSize === 1
          ? ["ping"]
          : Array.from({ length: seedSize }, (_, index) => `seed ${index}`);
      await seedRecord(databaseName, { version: 1, entries: seed });
      const first = storeFor(databaseName);
      const second = storeFor(databaseName);
      await Promise.all([first.ready, second.ready]);

      const appendA = first.append("echo a");
      const appendB = second.append("echo b");
      first.resetVisit();
      equal(first.getSnapshot(), [], "reset owns first local snapshot");
      await Promise.all([appendA, appendB]);
      equal(first.getSnapshot(), [], "late append completion does not refill reset");
      equal(second.getSnapshot(), seed.concat("echo b").slice(-200), "tabs stay independent");
      await first.append("echo c");
      equal(first.getSnapshot(), ["echo c"], "post-reset local delta only");

      const expected = seed.concat("echo a", "echo b", "echo c").slice(-200);
      const reopened = storeFor(databaseName);
      await reopened.ready;
      equal(reopened.getSnapshot(), expected, "reopen sees serialized concurrent archive");
      equal((await readRecord(databaseName)).entries, expected, "reset never clears durable archive");
    }
  };

  const malformedAndOversized = async () => {
    const oversizedName = name("oversized");
    const oversized = Array.from({ length: 201 }, (_, index) => `saved ${index}`);
    await seedRecord(oversizedName, { version: 1, entries: oversized });
    const oversizedStore = storeFor(oversizedName);
    await oversizedStore.ready;
    equal(oversizedStore.getSnapshot(), oversized.slice(-200), "oversized restore suffix");
    equal(
      (await readRecord(oversizedName)).entries,
      oversized.slice(-200),
      "oversized record normalized transactionally"
    );

    const malformed = [
      { label: "wrong-version", record: { version: 2, entries: ["future"] } },
      { label: "wrong-type", record: { version: 1, entries: "not-an-array" } },
      { label: "invalid-entry", record: { version: 1, entries: ["valid", 7] } },
    ];
    for (const fixture of malformed) {
      const databaseName = name(fixture.label);
      await seedRecord(databaseName, fixture.record);
      const store = storeFor(databaseName);
      await store.ready;
      equal(store.getSnapshot(), [], `${fixture.label} safe empty restore`);
      await store.append("memory only");
      equal(store.getSnapshot(), ["memory only"], `${fixture.label} usable visit memory`);
      equal(await readRecord(databaseName), fixture.record, `${fixture.label} untouched`);
    }

    const schemaName = name("schema");
    await seedRecord(schemaName, undefined, "other");
    const incompatible = storeFor(schemaName);
    await incompatible.ready;
    await incompatible.append("memory only");
    equal(incompatible.getSnapshot(), ["memory only"], "incompatible schema memory fallback");
    const database = await requestResult(indexedDB.open(schemaName, 1));
    assert(database.objectStoreNames.contains("other"), "incompatible schema retained");
    assert(!database.objectStoreNames.contains("state"), "incompatible schema not rewritten");
    database.close();
  };

  const wrappingFactory = (kind) => ({
    open(databaseName, version) {
      const wrapper = {};
      const request = indexedDB.open(databaseName, version);
      request.onblocked = () => wrapper.onblocked?.();
      request.onerror = () => {
        wrapper.error = request.error;
        wrapper.onerror?.();
      };
      request.onupgradeneeded = (event) => {
        wrapper.result = request.result;
        wrapper.transaction = request.transaction;
        wrapper.onupgradeneeded?.(event);
      };
      request.onsuccess = () => {
        const nativeDatabase = request.result;
        const database = {
          objectStoreNames: nativeDatabase.objectStoreNames,
          close: () => nativeDatabase.close(),
          set onversionchange(handler) {
            nativeDatabase.onversionchange = handler;
          },
          transaction(storeName, mode) {
            const nativeTransaction = nativeDatabase.transaction(storeName, mode);
            const transaction = {
              abort: () => nativeTransaction.abort(),
              objectStore(requestedStore) {
                const nativeStore = nativeTransaction.objectStore(requestedStore);
                return {
                  get: (key) => nativeStore.get(key),
                  put(value, key) {
                    if (kind === "quota") {
                      throw new DOMException("quota exhausted", "QuotaExceededError");
                    }
                    if (kind === "abort") {
                      nativeTransaction.abort();
                      return {};
                    }
                    if (kind === "error") {
                      throw new Error("controlled transaction error");
                    }
                    return nativeStore.put(value, key);
                  },
                };
              },
              set oncomplete(handler) {
                nativeTransaction.oncomplete = handler;
              },
              set onerror(handler) {
                nativeTransaction.onerror = handler;
              },
              set onabort(handler) {
                nativeTransaction.onabort = handler;
              },
            };
            return transaction;
          },
        };
        wrapper.result = database;
        wrapper.onsuccess?.();
      };
      return wrapper;
    },
  });

  const unavailableStorage = async () => {
    const denied = createCommandHistoryStore({
      get indexedDB() {
        throw new DOMException("denied", "SecurityError");
      },
      timeoutMs: 10,
    });
    await denied.ready;
    await denied.append("denied one");
    await denied.append("denied two");
    equal(denied.getSnapshot(), ["denied one", "denied two"], "denied memory");

    let blockedRequest;
    const blocked = createCommandHistoryStore({
      databaseName: name("blocked"),
      timeoutMs: 10,
      indexedDB: {
        open() {
          blockedRequest = {};
          queueMicrotask(() => blockedRequest.onblocked?.());
          return blockedRequest;
        },
      },
    });
    await blocked.ready;
    await blocked.append("blocked memory");
    equal(blocked.getSnapshot(), ["blocked memory"], "blocked memory");

    const timed = createCommandHistoryStore({
      databaseName: name("timeout"),
      timeoutMs: 5,
      indexedDB: { open: () => ({}) },
    });
    await timed.ready;
    await timed.append("timed memory");
    equal(timed.getSnapshot(), ["timed memory"], "timeout memory");

    for (const kind of ["error", "abort", "quota"]) {
      const databaseName = name(kind);
      const prior = { version: 1, entries: ["previous durable"] };
      await seedRecord(databaseName, prior);
      const store = createCommandHistoryStore({
        databaseName,
        timeoutMs: 80,
        indexedDB: wrappingFactory(kind),
      });
      await store.ready;
      const long = `echo ${"x".repeat(10000)}`;
      await store.append(long);
      await store.append("after failure");
      equal(
        store.getSnapshot(),
        ["previous durable", long, "after failure"],
        `${kind} keeps complete memory`
      );
      equal(await readRecord(databaseName), prior, `${kind} leaves durable record atomic`);
    }
  };

  const locality = async () => {
    localStorage.setItem("rootvc.aliases", '[["p","ping"]]');
    localStorage.setItem("rootvc.bookmarks", '{"docs":"~/docs"}');
    const before = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, localStorage.getItem(key)];
    }).sort();
    let networkCalls = 0;
    const originalFetch = window.fetch;
    const originalSendBeacon = navigator.sendBeacon;
    window.fetch = () => {
      networkCalls += 1;
      return Promise.reject(new Error("history attempted network access"));
    };
    navigator.sendBeacon = () => {
      networkCalls += 1;
      return false;
    };

    const databaseName = name("locality");
    const store = storeFor(databaseName);
    await store.ready;
    await store.append("echo browser only");
    store.resetVisit();
    const after = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, localStorage.getItem(key)];
    }).sort();
    equal(after, before, "unrelated browser data unchanged");
    assert(networkCalls === 0, "history made no network requests");
    window.fetch = originalFetch;
    navigator.sendBeacon = originalSendBeacon;
  };

  button.addEventListener("click", async () => {
    button.disabled = true;
    output.replaceChildren();
    try {
      await exactRetention();
      pass("PASS exact ordered retention: 0, 1, 199, 200, 201 and duplicates");
      await concurrentReset();
      pass("PASS concurrent appends and visit-only reset preserve saved history");
      await malformedAndOversized();
      pass("PASS malformed, incompatible and oversized records");
      await unavailableStorage();
      pass("PASS denied, blocked, aborted, timed-out and quota storage");
      await locality();
      pass("PASS unrelated data and browser-only storage");
      pass("STORE CHECKS COMPLETE");
    } catch (error) {
      pass(`FAIL ${error && error.stack ? error.stack : error}`);
    }
  });
})();

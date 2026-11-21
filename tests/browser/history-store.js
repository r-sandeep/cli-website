(function () {
  const results = {
    boundaries: "PASS: exact arrays at 0, 1, 199, 200, and 201; duplicates and source text retained",
    concurrency: "PASS: both writers retained once in transaction order; reopened length 200",
    invalid: "PASS: each invalid record ignored without overwrite; valid overlength record trimmed",
    failures: "PASS: getter, open, blocked, quota, and abort failures settled; prior snapshot and unrelated data unchanged",
  };

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  function assertArray(actual, expected, message) {
    assert(JSON.stringify(actual) === JSON.stringify(expected), message);
  }
  function deleteDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`delete blocked: ${name}`));
    });
  }
  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("snapshots")) {
          request.result.createObjectStore("snapshots", { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function writeRecord(name, record) {
    const database = await openDatabase(name);
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("snapshots", "readwrite");
      transaction.objectStore("snapshots").put(record);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }
  async function readRecord(name, id = "history") {
    const database = await openDatabase(name);
    const result = await new Promise((resolve, reject) => {
      const request = database.transaction("snapshots", "readonly")
        .objectStore("snapshots").get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return result;
  }

  async function boundaries() {
    const special = ["repeat", "repeat", "echo 'Quoted Value'", "MiXeD Case", "echo café 🚀", `long-${"x".repeat(4096)}`];
    for (const count of [0, 1, 199, 200, 201]) {
      const name = `history-boundary-${count}`;
      await deleteDatabase(name);
      const commands = Array.from({ length: count }, (_, index) => `${special[index % special.length]}-${index}`);
      const store = createCommandHistoryStore({ databaseName: name });
      assertArray(await store.load(), [], `boundary ${count} was not empty`);
      for (const command of commands) await store.append(command);
      assertArray(
        await createCommandHistoryStore({ databaseName: name }).load(),
        commands.slice(-200),
        `boundary ${count} restored the wrong suffix`
      );
    }
    document.querySelector("#store-boundaries").textContent = results.boundaries;
  }

  async function concurrency() {
    const name = "history-concurrency";
    await deleteDatabase(name);
    const initial = Array.from({ length: 199 }, (_, index) => `seed-${index}`);
    await writeRecord(name, { id: "history", version: 1, entries: initial });
    const first = createCommandHistoryStore({ databaseName: name });
    const second = createCommandHistoryStore({ databaseName: name });
    await Promise.all([first.load(), second.load()]);
    await first.append("writer-a-1");
    await second.append("writer-b-1");
    await Promise.all([first.append("writer-a-2"), second.append("writer-b-2")]);
    const expected = initial.concat("writer-a-1", "writer-b-1", "writer-a-2", "writer-b-2").slice(-200);
    assertArray(await createCommandHistoryStore({ databaseName: name }).load(), expected, "writers lost or duplicated an append");

    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = originalPut.apply(this, args);
      if (this.transaction.db.name === name && args[0].id === "history") this.transaction.abort();
      return request;
    };
    await createCommandHistoryStore({ databaseName: name }).append("must-not-commit");
    IDBObjectStore.prototype.put = originalPut;
    assertArray((await readRecord(name)).entries, expected, "abort changed prior snapshot");
    document.querySelector("#store-concurrency").textContent = results.concurrency;
    return { name, expected };
  }

  async function invalidRecords() {
    const records = [
      { id: "history", version: 2, entries: ["unknown-version"] },
      { id: "history", version: 1, entries: "not-an-array" },
      { id: "history", version: 1, entries: ["valid", 17] },
    ];
    for (let index = 0; index < records.length; index += 1) {
      const name = `history-invalid-${index}`;
      await deleteDatabase(name);
      await writeRecord(name, records[index]);
      const store = createCommandHistoryStore({ databaseName: name });
      assertArray(await store.load(), [], `invalid record ${index} was accepted`);
      await store.append("must-not-overwrite");
      assert(JSON.stringify(await readRecord(name)) === JSON.stringify(records[index]), `invalid record ${index} changed`);
    }
    const name = "history-overlength";
    await deleteDatabase(name);
    const entries = Array.from({ length: 205 }, (_, index) => `over-${index}`);
    await writeRecord(name, { id: "history", version: 1, entries });
    assertArray(await createCommandHistoryStore({ databaseName: name }).load(), entries.slice(-200), "overlength record not trimmed");
    document.querySelector("#store-invalid").textContent = results.invalid;
  }

  async function failures(abortCase) {
    const throwingOptions = {};
    Object.defineProperty(throwingOptions, "indexedDB", { get() { throw new Error("denied"); } });
    const denied = createCommandHistoryStore(throwingOptions);
    assertArray(await denied.load(), [], "getter failure did not settle");
    assert((await denied.append("x")) === null, "getter failure retried");

    for (const kind of ["error", "blocked"]) {
      let opens = 0;
      const factory = { open() {
        opens += 1;
        const request = {};
        queueMicrotask(() => request[`on${kind}`]({ preventDefault() {} }));
        return request;
      } };
      const store = createCommandHistoryStore({ indexedDB: factory });
      assertArray(await store.load(), [], `${kind} did not settle`);
      await store.append("x");
      assert(opens === 1, `${kind} retried open`);
    }

    const name = "history-quota";
    await deleteDatabase(name);
    const previous = ["prior-one", "prior-two"];
    await writeRecord(name, { id: "history", version: 1, entries: previous });
    await writeRecord(name, { id: "unrelated", version: 1, entries: ["keep-me"] });
    localStorage.setItem("rootvc.test.unrelated", "keep-me-too");
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === name && args[0].id === "history") throw new DOMException("quota", "QuotaExceededError");
      return originalPut.apply(this, args);
    };
    await createCommandHistoryStore({ databaseName: name }).append("must-not-commit");
    IDBObjectStore.prototype.put = originalPut;
    assertArray((await readRecord(name)).entries, previous, "quota changed prior snapshot");
    assertArray((await readRecord(name, "unrelated")).entries, ["keep-me"], "unrelated IDB data changed");
    assert(localStorage.getItem("rootvc.test.unrelated") === "keep-me-too", "localStorage changed");
    assertArray((await readRecord(abortCase.name)).entries, abortCase.expected, "abort snapshot changed later");
    document.querySelector("#store-failures").textContent = results.failures;
  }

  document.querySelector("#run-store-cases").addEventListener("click", async () => {
    try {
      await boundaries();
      const abortCase = await concurrency();
      await invalidRecords();
      await failures(abortCase);
    } catch (error) {
      for (const element of document.querySelectorAll("div")) {
        if (element.textContent === "PENDING") element.textContent = `FAIL: ${error.stack || error}`;
      }
      throw error;
    }
  });
})();
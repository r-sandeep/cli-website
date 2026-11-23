(() => {
  "use strict";

  const output = document.querySelector("#store-results");
  const button = document.querySelector("#run-store");
  const terminalOutput = document.querySelector("#terminal-results");
  const terminalButton = document.querySelector("#run-terminal");
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
  const passTo = (target, line) => {
    const row = document.createElement("div");
    row.textContent = line;
    target.appendChild(row);
  };
  const pass = (line) => passTo(output, line);

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
      submitted.push(submitted[101]);
      await store.append(submitted[submitted.length - 1]);
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

  const waitFor = async (predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(message);
  };

  const createTerminal = () => {
    const handlers = new Set();
    const rendered = [];
    const term = {
      VERSION: 4,
      _initialized: false,
      buffer: { active: { cursorX: 0 } },
      busy: false,
      cols: 80,
      currentLine: "",
      focus() {},
      loadAddon() {},
      locked: false,
      open() {},
      reset() { rendered.length = 0; },
      scrollToBottom() {},
      write(value) { rendered.push(String(value)); },
      writeln(value = "") { rendered.push(`${value}\r\n`); },
      attachCustomKeyEventHandler(handler) { this._customKeyHandler = handler; },
      onData(handler) {
        handlers.add(handler);
        return { dispose: () => handlers.delete(handler) };
      },
      emit(data) {
        for (const handler of [...handlers]) handler(data);
      },
      rendered,
    };
    window.term = term;
    window.LOGO_TYPE = "ROOT";
    window.fitAddon = { fit() {} };
    window.scheduleIdleTask = (task) => task();
    window.ensureASCIIArt = async () => {};
    window.ensureFileLoaded = async () => {};
    window.preloadASCIIArt = async () => {};
    window.dataLayer = [];
    extend(term);
    // The fixture is line-oriented and keeps its synthetic cursor at the end of
    // input; production setCurrentLine/onData/execute handlers remain unchanged.
    term.pos = () => term.currentLine.length;
    term.timer = async () => {};
    term.progressBar = async () => {};
    term.dottedPrint = async (text, _count, newline = true) =>
      term.write(`${text}${newline ? "\r\n" : ""}`);
    term.delayPrint = async (text) => term.write(text);
    term.delayStylePrint = async (text, _delay, wrap) => term.stylePrint(text, wrap);
    return term;
  };

  const reopenTerminal = async () => {
    const term = createTerminal();
    await term.historyReady;
    runRootTerminal(term);
    return term;
  };

  const runTerminalChecks = async () => {
    localStorage.clear();
    await deleteDatabase(COMMAND_HISTORY_DATABASE);

    const first = await reopenTerminal();
    assert(first.history.length === 0, "fresh terminal starts empty");
    await first.executeCommandLine("echo saved one", { promptAfter: false });
    await first.executeCommandLine("nosuchhistorycmd", { promptAfter: false });

    const returned = await reopenTerminal();
    equal(returned.history, ["echo saved one", "nosuchhistorycmd"], "restore order");
    assert(returned.currentLine === "", "restore leaves pending input empty");
    assert(window.dataLayer.length === 0, "restore emits no analytics");
    returned.emit("\033[A");
    assert(returned.currentLine === "nosuchhistorycmd", "ArrowUp selects newest saved line");
    assert(window.dataLayer.length === 0, "recall alone emits no analytics");
    passTo(terminalOutput, "PASS restore precedes first prompt and never executes saved commands");

    for (let index = 0; index < 201; index += 1) {
      await returned.executeCommandLine(`missing ${index}`, { promptAfter: false });
    }
    assert(returned.history.length === 200, "terminal recall is capped at 200");
    assert(returned.history[0] === "missing 1", "oldest entry is evicted at 201");
    returned.historyCursor = -1;
    returned.currentLine = "";
    for (let index = 0; index < 205; index += 1) returned.emit("\033[A");
    assert(returned.currentLine === "missing 1", "ArrowUp stops at retained oldest entry");
    await returned.executeCommandLine("history", { promptAfter: false });
    assert(returned.history.length === 200, "history self-inclusion preserves cap");
    assert(returned.rendered.some((line) => line.includes("1000  missing 2")), "history starts at 1000");
    assert(returned.rendered.some((line) => line.includes("1199  history")), "history ends at 1199");
    passTo(terminalOutput, "PASS full 200-entry listing and ArrowUp boundary");

    const descriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      get() { throw new DOMException("denied", "SecurityError"); },
    });
    const denied = createTerminal();
    await denied.historyReady;
    runRootTerminal(denied);
    await denied.executeCommandLine("ping", { promptAfter: false });
    await denied.executeCommandLine("echo one two | wc -l", { promptAfter: false });
    equal(denied.history, ["ping", "echo one two | wc -l"], "denied visit history");
    denied.currentLine = "";
    denied.emit("\033[A");
    assert(denied.currentLine === "echo one two | wc -l", "denied recall remains usable");
    if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
    else delete window.indexedDB;

    const quotaFactory = wrappingFactory("quota");
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: quotaFactory,
    });
    const quota = createTerminal();
    await quota.historyReady;
    runRootTerminal(quota);
    await quota.executeCommandLine("ping", { promptAfter: false });
    await quota.executeCommandLine("history", { promptAfter: false });
    await quota.executeCommandLine("echo after quota", { promptAfter: false });
    equal(quota.history.slice(-3), ["ping", "history", "echo after quota"], "quota visit history");
    if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
    passTo(terminalOutput, "PASS denied storage and quota failure retain usable visit history");

    const replayed = await reopenTerminal();
    assert(replayed.environment.get("OLD") === undefined, "restored commands have not executed");
    const replayAnalytics = window.dataLayer.length;
    let nextCols = 100;
    window.fitAddon.fit = () => { replayed.cols = nextCols; };
    await replayed.resizeListener();
    assert(replayed.environment.get("OLD") === undefined, "resize does not execute restored archive");
    assert(window.dataLayer.length === replayAnalytics, "resize restore emits no analytics");
    await replayed.executeCommandLine("export VISIT=one", { promptAfter: false });
    const historyBeforeResize = [...replayed.history];
    const analyticsBeforeResize = window.dataLayer.map((entry) => ({ ...entry }));
    nextCols = 120;
    await replayed.resizeListener();
    equal(replayed.history, historyBeforeResize, "resize does not append history");
    equal(window.dataLayer, analyticsBeforeResize, "resize does not duplicate analytics");
    assert(replayed.environment.get("VISIT") === "one", "visit environment survives resize");
    await replayed.executeCommandLine("ping", { promptAfter: false });
    assert(replayed.rendered.some((line) => line.includes("pong")), "next command remains usable");
    passTo(terminalOutput, "PASS resize replays only this visit and preserves next command");

    for (const reset of ["clear", "zsh", "upgrade"]) {
      const beforeReset = await reopenTerminal();
      await beforeReset.executeCommandLine("echo before reset", { promptAfter: false });
      await beforeReset.executeCommandLine(reset, { promptAfter: false });
      equal(beforeReset.history, [], `${reset} clears visit recall`);
      beforeReset.currentLine = "";
      beforeReset.emit("\033[A");
      assert(beforeReset.currentLine === "", `${reset} leaves ArrowUp empty`);
      const afterReset = await reopenTerminal();
      assert(afterReset.history.at(-1) === reset, `${reset} remains in saved archive`);
      await afterReset.executeCommandLine("ping", { promptAfter: false });
      assert(afterReset.rendered.some((line) => line.includes("pong")), `${reset} preserves command use`);
    }
    passTo(terminalOutput, "PASS clear, zsh and upgrade clear visit only and preserve saved history");

    const compatible = await reopenTerminal();
    await compatible.executeCommandLine("alias hp=ping", { promptAfter: false });
    await compatible.executeCommandLine("hp", { promptAfter: false });
    assert(compatible.getAlias("hp") === "ping", "alias representation preserved");
    await compatible.executeCommandLine("export KEEP=value", { promptAfter: false });
    assert(compatible.environment.get("KEEP") === "value", "environment preserved");
    const cwd = compatible.cwd;
    await compatible.executeCommandLine("bookmark add home", { promptAfter: false });
    await compatible.executeCommandLine("go home", { promptAfter: false });
    assert(compatible.cwd === cwd, "bookmark retains cwd representation");
    const historyBeforeDeepLink = [...compatible.history];
    compatible.deepLink = "ping";
    await compatible.runDeepLink();
    equal(compatible.history, historyBeforeDeepLink, "deep link is excluded from history");
    passTo(terminalOutput, "PASS aliases, variables, bookmarks and deep links remain compatible");

    const analyticsTerm = await reopenTerminal();
    window.dataLayer = [];
    const pingResult = await analyticsTerm.executeCommandLine("ping", { promptAfter: false });
    assert(pingResult === undefined, "ordinary return value unchanged");
    equal(window.dataLayer, [{ event: "commandSent", command: "ping", args: "" }], "ordinary analytics payload");
    const countBeforeReplay = window.dataLayer.length;
    let analyticsCols = 110;
    window.fitAddon.fit = () => { analyticsTerm.cols = analyticsCols; };
    await analyticsTerm.resizeListener();
    assert(window.dataLayer.length === countBeforeReplay, "replay emits no analytics");
    analyticsTerm.deepLink = "ping";
    await analyticsTerm.runDeepLink();
    assert(window.dataLayer.length === countBeforeReplay + 1, "arrival deep link emits once");
    const apply = analyticsTerm.executeCommandLine("apply 1", { promptAfter: false });
    await waitFor(() => analyticsTerm.activeInput, "application input did not start");
    analyticsTerm.emit("\u0003");
    assert((await apply) === 1, "interactive cancellation return remains 1");
    passTo(terminalOutput, "PASS analytics counts, payloads and interactive return values");
  };

  terminalButton.addEventListener("click", async () => {
    terminalButton.disabled = true;
    terminalOutput.replaceChildren();
    try {
      await runTerminalChecks();
      passTo(terminalOutput, "TERMINAL CHECKS COMPLETE");
    } catch (error) {
      passTo(terminalOutput, `FAIL ${error && error.stack ? error.stack : error}`);
    }
  });

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

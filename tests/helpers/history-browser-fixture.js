(() => {
  "use strict";

  const output = document.querySelector("#store-results");
  const button = document.querySelector("#run-store");
  const terminalOutput = document.querySelector("#terminal-results");
  const terminalButton = document.querySelector("#run-terminal");
  const writeExceptionOutput = document.querySelector("#write-exception-results");
  const writeExceptionButton = document.querySelector("#run-write-exceptions");
  const executionTimingOutput = document.querySelector("#execution-timing-results");
  const executionTimingButton = document.querySelector("#run-execution-timing");
  const pendingResizeOutput = document.querySelector("#pending-resize-results");
  const pendingResizeButton = document.querySelector("#run-pending-resize");
  const lifecycleOutput = document.querySelector("#lifecycle-repair-results");
  const lifecycleButton = document.querySelector("#run-lifecycle-repair");
  const submissionScopeStatus = document.querySelector("#submission-scope-status");
  const submissionScopeOutput = document.querySelector("#submission-scope-results");
  const submissionScopeButton = document.querySelector("#run-submission-scope");
  const prefix = `asd-history-${Date.now()}-${Math.random()}`;
  // Helpers and existing controls always use the native factory, even while the
  // execution-timing fixture temporarily installs a transaction wrapper.
  const nativeIndexedDB = indexedDB;
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
      const request = nativeIndexedDB.deleteDatabase(databaseName);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`delete blocked: ${databaseName}`));
    });

  const seedRecord = async (databaseName, record, storeName = "state") => {
    await deleteDatabase(databaseName);
    const request = nativeIndexedDB.open(databaseName, 1);
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
    const database = await requestResult(nativeIndexedDB.open(databaseName, 1));
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
      indexedDB: nativeIndexedDB,
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
    const database = await requestResult(nativeIndexedDB.open(schemaName, 1));
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

  const throwingPutFactory = () => wrappingFactory("quota");

  const holdingFactory = () => {
    // Capture the native factory before this wrapper is installed on window;
    // resolving the global `indexedDB` afterward would recurse into this wrapper.
    const nativeIndexedDB = indexedDB;
    const controller = {
      hold: false,
      pending: [],
      releaseNext() {
        const complete = this.pending.shift();
        if (complete) complete();
      },
      releaseAll() {
        while (this.pending.length > 0) this.releaseNext();
      },
    };
    const factory = {
      open(databaseName, version) {
        const wrapper = {};
        const request = nativeIndexedDB.open(databaseName, version);
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
          wrapper.result = {
            objectStoreNames: nativeDatabase.objectStoreNames,
            close: () => nativeDatabase.close(),
            set onversionchange(handler) { nativeDatabase.onversionchange = handler; },
            transaction(storeName, mode) {
              const nativeTransaction = nativeDatabase.transaction(storeName, mode);
              const transaction = {
                abort: () => nativeTransaction.abort(),
                objectStore: (requestedStore) => nativeTransaction.objectStore(requestedStore),
                set oncomplete(handler) {
                  nativeTransaction.oncomplete = () => {
                    if (controller.hold) controller.pending.push(handler);
                    else handler();
                  };
                },
                set onerror(handler) { nativeTransaction.onerror = handler; },
                set onabort(handler) { nativeTransaction.onabort = handler; },
              };
              return transaction;
            },
          };
          wrapper.onsuccess?.();
        };
        return wrapper;
      },
    };
    return { controller, factory };
  };

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

  const createTerminal = (actualRenderer = false) => {
    const handlers = new Set();
    const rendered = [];
    const term = actualRenderer
      ? new Terminal({ cols: 100, rows: 24, scrollback: 1000 })
      : {
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
    if (actualRenderer) {
      term.open(document.querySelector("#actual-terminal"));
      term.rendered = rendered;
      const nativeWrite = term.write.bind(term);
      const nativeWriteln = term.writeln.bind(term);
      term.write = (value, callback) => {
        rendered.push(String(value));
        if (callback && term.onResetDrainQueued) {
          const onResetDrainQueued = term.onResetDrainQueued;
          term.onResetDrainQueued = null;
          onResetDrainQueued();
        }
        return nativeWrite(value, callback);
      };
      term.writeln = (value = "", callback) => {
        rendered.push(`${value}\r\n`);
        return nativeWriteln(value, callback);
      };
      term.emit = (data) => {
        for (const handler of [...handlers]) handler(data);
      };
      const nativeOnData = term.onData.bind(term);
      Object.defineProperty(term, "onData", {
        configurable: true,
        value(handler) {
          handlers.add(handler);
          const nativeDisposable = nativeOnData(handler);
          return {
            dispose() {
              handlers.delete(handler);
              nativeDisposable.dispose();
            },
          };
        },
      });
      term.emit = (data) => {
        for (const handler of [...handlers]) handler(data);
      };
    }
    term.VERSION = 4;
    term._initialized = false;
    term.busy = false;
    term.currentLine = "";
    term.locked = false;
    window.term = term;
    window.LOGO_TYPE = "ROOT";
    window.fitAddon = actualRenderer
      ? { fit() {} }
      : { fit() {} };
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

  let executionFixture;
  const executionFixtureReady = (async () => {
    const held = holdingFactory();
    const descriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: held.factory,
    });
    const term = createTerminal();
    await term.historyReady;
    runRootTerminal(term);
    held.controller.hold = true;
    executionFixture = { ...held, descriptor, term };
    if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
    else delete window.indexedDB;
    executionTimingButton.disabled = false;
  })();

  const runExecutionTimingChecks = async ({ controller, descriptor, term }) => {
    // Production command handlers resolve the active classic-script terminal
    // through window.term. Re-select this fixture's own terminal after other
    // isolated terminal journeys have run on the same generated page.
    window.term = term;
    const originalOpen = window.open;
    const opened = [];
    window.open = (url, target) => {
      opened.push({ url, target, active: navigator.userActivation.isActive });
      const popup = originalOpen.call(window, url, target);
      if (popup) popup.close();
      return popup;
    };

    // This call is intentionally the first asynchronous action in the activated
    // click task. Only completion delivery is held; production preload and
    // dispatch remain untouched.
    const agmExecution = term.executeCommandLine("agm", { promptAfter: false });
    await waitFor(() => opened.length === 1, "agm did not call window.open");
    equal(
      [opened[0].url, opened[0].target],
      ["http://annualmeeting.root.vc", "_blank"],
      "agm destination and target"
    );
    assert(opened[0].active, "agm lost browser activation before opening");
    await waitFor(
      () => controller.pending.length > 0,
      "agm storage completion was not held"
    );
    controller.releaseNext();
    await agmExecution;
    window.open = originalOpen;

    const executeHeld = async (line, check, options = {}) => {
      let settled = false;
      const execution = term.executeCommandLine(line, {
        promptAfter: false,
        ...options,
      });
      execution.then(() => { settled = true; });
      await waitFor(() => !term.busy, `${line} did not release busy state`);
      check();
      assert(!settled, `${line} resolved before history settlement`);
      await waitFor(
        () => controller.pending.length > 0,
        `${line} did not reach held settlement`
      );
      controller.releaseNext();
      const result = await execution;
      return result;
    };

    const renderedCount = (text) =>
      term.rendered.filter((line) => line.includes(text)).length;
    await executeHeld("ping", () => assert(renderedCount("pong") === 1, "ping feedback"));
    await executeHeld("echo invalid | head 0", () =>
      assert(renderedCount("head: count must be a positive base-10 integer") === 1, "rejection feedback")
    );

    const nativePreload = term.preloadCommandAssets;
    for (const line of ["cat missing", "echo pipeline | grep pipeline"]) {
      term.preloadCommandAssets = async () => {
        throw new Error("controlled preload failure");
      };
      await executeHeld(line, () =>
        assert(
          renderedCount("Command failed to load required assets. Please try again.") > 0,
          `${line} preload feedback`
        )
      );
    }
    term.preloadCommandAssets = nativePreload;
    commands.__asd_throw = () => { throw new Error("controlled command failure"); };
    await executeHeld("__asd_throw", () =>
      assert(
        renderedCount("Command failed to load required assets. Please try again.") > 0,
        "throw feedback"
      )
    );
    delete commands.__asd_throw;
    passTo(
      executionTimingOutput,
      "PASS all execution exits await bounded history settlement after ordinary feedback"
    );

    const observedExecutions = [];
    const productionExecute = term.executeCommandLine.bind(term);
    term.executeCommandLine = (...args) => {
      const execution = productionExecute(...args);
      observedExecutions.push(execution);
      return execution;
    };
    const submit = async (line, resultText) => {
      term.currentLine = line;
      term.emit("\r");
      await waitFor(() => renderedCount(resultText) > 0 && !term.busy, `${line} result missing`);
    };
    const pongBefore = renderedCount("pong");
    await submit("ping", "pong");
    const followupBefore = renderedCount("followup");
    await submit("echo followup", "followup");
    for (const character of "echo pending") term.emit(character);
    assert(term.currentLine === "echo pending", "third pending line was not entered");
    assert(renderedCount("pong") === pongBefore + 1, "ping executed more than once");
    assert(renderedCount("followup") === followupBefore + 1, "followup executed more than once");
    passTo(
      executionTimingOutput,
      "PASS production input executes follow-up commands while history settlement is pending"
    );
    const rapidExecutions = observedExecutions.splice(0);
    for (const execution of rapidExecutions) {
      await waitFor(
        () => controller.pending.length > 0,
        "rapid submission did not reach held settlement"
      );
      controller.releaseNext();
      await execution;
    }
    assert(term.currentLine === "echo pending", "late settlement erased newer pending input");
    passTo(
      executionTimingOutput,
      "PASS late settlement preserves newer pending input and exact saved order"
    );
    passTo(
      executionTimingOutput,
      "PASS agm opens its unchanged destination within browser activation before storage release"
    );

    await executeHeld("alias hp=ping", () => assert(term.getAlias("hp") === "ping", "alias unchanged"));
    await executeHeld("hp", () => assert(renderedCount("pong") === pongBefore + 2, "alias dispatch"));
    await executeHeld("echo one two | wc -l", () => assert(renderedCount("1") > 0, "pipeline result"));
    await executeHeld("echo unused | head 0", () =>
      assert(renderedCount("head: count must be a positive base-10 integer") > 0, "pipeline rejection")
    );

    const originalFetch = window.fetch;
    let applicationPosts = 0;
    window.fetch = (...args) => {
      applicationPosts += 1;
      return originalFetch(...args);
    };
    term.currentLine = "apply 1";
    term.emit("\r");
    await waitFor(() => term.activeInput, "application prompt did not start");
    assert(term.rendered.some((line) => line.includes("What's your name?")), "application prompt missing");
    term.emit("\u0003");
    await waitFor(() => !term.locked && !term.busy, "application cancellation did not release input");
    assert(term.rendered.some((line) => line.includes("Application cancelled.")), "cancellation output missing");
    assert(applicationPosts === 0, "cancelled application posted data");
    controller.releaseAll();
    await Promise.all(observedExecutions.splice(0));
    window.fetch = originalFetch;
    await executeHeld("ping", () => assert(renderedCount("pong") === pongBefore + 3, "post-cancel ping"));
    assert(!term.history.includes("Ada"), "form answer entered command history");
    passTo(
      executionTimingOutput,
      "PASS alias pipeline rejection and interactive continuation contracts remain unchanged"
    );

    controller.hold = false;
    const restored = createTerminal();
    await restored.historyReady;
    const expectedSuffix = term.history.slice(-200);
    equal(restored.history, expectedSuffix, "restored submission order after held completions");
    if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
    else delete window.indexedDB;
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
    returned.emit("\u001b[A");
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
    for (let index = 0; index < 205; index += 1) returned.emit("\u001b[A");
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
    denied.emit("\u001b[A");
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
      beforeReset.emit("\u001b[A");
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

  const runPendingResizeChecks = async () => {
    localStorage.clear();
    await deleteDatabase(COMMAND_HISTORY_DATABASE);

    const term = createTerminal();
    await term.historyReady;
    runRootTerminal(term);
    const nativePreload = term.preloadCommandAssets;
    let releasePreload;
    term.preloadCommandAssets = () =>
      new Promise((resolve) => { releasePreload = resolve; });
    let cols = 100;
    window.fitAddon.fit = () => { term.cols = cols; cols += 20; };
    const analyticsBefore = window.dataLayer.length;
    const pending = term.executeCommandLine("export PENDING=once", { promptAfter: false });
    await waitFor(() => releasePreload, "pending preload did not start");
    await term.resizeListener();
    await term.resizeListener();
    assert(term.environment.get("PENDING") === undefined, "resize dispatched pending preload");
    assert(window.dataLayer.length === analyticsBefore, "pending resize emitted analytics");
    passTo(pendingResizeOutput, "PASS resize before first dispatch never executes pending work");

    releasePreload();
    await pending;
    term.preloadCommandAssets = nativePreload;
    assert(term.environment.get("PENDING") === "once", "first execution did not dispatch once");
    assert(window.dataLayer.length === analyticsBefore + 1, "first execution analytics count");
    const historyAfterPending = [...term.history];
    passTo(
      pendingResizeOutput,
      "PASS pending history completion causes no duplicate dispatch history or analytics"
    );

    for (const reset of ["clear", "zsh", "upgrade"]) {
      await term.executeCommandLine("echo reset fence", { promptAfter: false });
      await term.executeCommandLine(reset, { promptAfter: false });
      equal(term.history, [], `${reset} clears current recall`);
      await term.resizeListener();
      equal(term.history, [], `${reset} resize preserves cleared recall`);
    }
    passTo(pendingResizeOutput, "PASS clear zsh and upgrade fence late replay publication");

    await term.executeCommandLine("export KEEP=before", { promptAfter: false });
    await term.executeCommandLine("export TEMP=original", { promptAfter: false });
    await term.executeCommandLine("unset TEMP", { promptAfter: false });
    term.environment.set("KEEP", "live");
    term.environment.set("TEMP", "live");
    term.environment.set("EXTRA", "later");
    const environmentBefore = term.environment.entries();
    const persistedBefore = localStorage.getItem("rootvc.cli.environment.v1");
    const historyBeforeReplay = [...term.history];
    const analyticsBeforeReplay = window.dataLayer.map((entry) => ({ ...entry }));
    await term.resizeListener();
    equal(term.environment.entries(), environmentBefore, "idle replay restores full live environment");
    assert(
      localStorage.getItem("rootvc.cli.environment.v1") === persistedBefore,
      "idle replay changed persisted environment"
    );
    equal(term.history, historyBeforeReplay, "idle replay does not append history");
    equal(window.dataLayer, analyticsBeforeReplay, "idle replay does not append analytics");
    passTo(pendingResizeOutput, "PASS idle replay preserves exclusions environment and interactive ownership");

    await term.executeCommandLine("ping", { promptAfter: false });
    await term.executeCommandLine("history", { promptAfter: false });
    assert(term.rendered.some((line) => line.includes("pong")), "next command did not produce pong");
    const restored = createTerminal();
    await restored.historyReady;
    const durableSubmissions = [
      "export PENDING=once",
      "echo reset fence",
      "clear",
      "echo reset fence",
      "zsh",
      "echo reset fence",
      "upgrade",
      "export KEEP=before",
      "export TEMP=original",
      "unset TEMP",
      "ping",
      "history",
    ];
    equal(
      restored.history,
      durableSubmissions.slice(-200),
      "reload restores exact newest-200 durable submission sequence"
    );
    assert(
      restored.history.filter((line) => line === "export PENDING=once").length === 1,
      "pending submission duplicated in durable history"
    );
    assert(historyAfterPending.filter((line) => line === "export PENDING=once").length === 1,
      "pending submission duplicated in visit history");
    passTo(pendingResizeOutput, "PASS next command and reload retain the exact newest-200 submission sequence");
  };

  const runLifecycleRepairChecks = async () => {
    localStorage.clear();

    const failedName = name("lifecycle-sticky-failure");
    const prior = { version: 1, entries: ["previous"] };
    await seedRecord(failedName, prior);
    let writeAttempts = 0;
    const stickyFactory = wrappingFactory("quota");
    const originalOpen = stickyFactory.open.bind(stickyFactory);
    stickyFactory.open = (...args) => {
      const request = originalOpen(...args);
      let nativeSuccess = request.onsuccess;
      Object.defineProperty(request, "onsuccess", {
        configurable: true,
        get: () => nativeSuccess,
        set(handler) {
          nativeSuccess = function () {
            handler();
            const database = request.result;
            if (!database || database.__counted) return;
            database.__counted = true;
            const originalTransaction = database.transaction.bind(database);
            database.transaction = (...transactionArgs) => {
              const transaction = originalTransaction(...transactionArgs);
              const originalObjectStore = transaction.objectStore.bind(transaction);
              transaction.objectStore = (...storeArgs) => {
                const store = originalObjectStore(...storeArgs);
                const originalPut = store.put.bind(store);
                store.put = (...putArgs) => {
                  writeAttempts += 1;
                  return originalPut(...putArgs);
                };
                return store;
              };
              return transaction;
            };
          };
        },
      });
      return request;
    };
    const failed = createCommandHistoryStore({
      databaseName: failedName,
      indexedDB: stickyFactory,
      timeoutMs: 80,
    });
    await failed.ready;
    const first = failed.append("first");
    const second = failed.append("second");
    const third = failed.append("third");
    await Promise.all([first, second, third]);
    equal(failed.getSnapshot(), ["previous", "first", "second", "third"], "sticky failure memory");
    equal(await readRecord(failedName), prior, "sticky failure leaves durable archive");
    assert(writeAttempts === 1, `queued writes started after sticky failure: ${writeAttempts}`);
    passTo(lifecycleOutput, "PASS failed append fences queued writes and preserves complete memory and durable state");

    for (const seedSize of [0, 1, 199, 200]) {
      const databaseName = name(`lifecycle-healthy-${seedSize}`);
      const seed = Array.from({ length: seedSize }, (_, index) => `seed ${index}`);
      await seedRecord(databaseName, { version: 1, entries: seed });
      const firstStore = storeFor(databaseName);
      const secondStore = storeFor(databaseName);
      await Promise.all([firstStore.ready, secondStore.ready]);
      await Promise.all([firstStore.append("duplicate"), secondStore.append("other")]);
      await firstStore.append("duplicate");
      firstStore.resetVisit();
      await firstStore.append("after reset");
      const expected = seed.concat("duplicate", "other", "duplicate", "after reset").slice(-200);
      equal((await readRecord(databaseName)).entries, expected, `healthy archive ${seedSize}`);
      equal(firstStore.getSnapshot(), ["after reset"], `independent reset ${seedSize}`);
    }
    passTo(lifecycleOutput, "PASS healthy interleaved appends and resets retain the exact newest-200 archive");

    await deleteDatabase(COMMAND_HISTORY_DATABASE);
    const held = holdingFactory();
    const descriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
    Object.defineProperty(window, "indexedDB", { configurable: true, value: held.factory });
    const term = createTerminal();
    await term.historyReady;
    runRootTerminal(term);
    held.controller.hold = true;
    const execution = term.executeCommandLine("ping", { promptAfter: false });
    await waitFor(() => !term.busy && held.controller.pending.length > 0, "completed ping did not reach held storage");
    term.currentLine = "echo pending";
    window.fitAddon.fit = () => { term.cols = 100; };
    await term.resizeListener();
    assert(term.rendered.some((line) => line.includes("pong")), "resize dropped completed pong output");
    assert(term.currentLine === "echo pending", "resize lost pending input");
    held.controller.releaseAll();
    await execution;
    assert(term.history.filter((line) => line === "ping").length === 1, "resize duplicated history");
    passTo(lifecycleOutput, "PASS completed output survives resize before history settlement");
    if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
    else delete window.indexedDB;

    const exactName = name("lifecycle-exact");
    await seedRecord(exactName, { version: 1, entries: [] });
    const exactStore = storeFor(exactName);
    await exactStore.ready;
    const exact = "  echo spaced  ";
    await exactStore.append(exact);
    equal(exactStore.getSnapshot(), [exact], "exact visit snapshot");
    equal((await readRecord(exactName)).entries, [exact], "exact durable snapshot");
    const exactRestored = storeFor(exactName);
    await exactRestored.ready;
    equal(exactRestored.getSnapshot(), [exact], "exact restored snapshot");
    const exactTerm = createTerminal();
    exactTerm.historyReady = Promise.resolve().then(() => {
      exactTerm.history = exactRestored.getSnapshot();
      exactTerm.historyCursor = -1;
    });
    await exactTerm.historyReady;
    runRootTerminal(exactTerm);
    exactTerm.emit("\u001b[A");
    assert(exactTerm.currentLine === exact, "ArrowUp did not preserve exact text");
    exactTerm.emit("\r");
    await waitFor(() => !exactTerm.busy, "exact recalled command did not finish");
    await exactTerm.executeCommandLine("history", { promptAfter: false });
    assert(exactTerm.rendered.some((line) => line.includes(`1000  ${exact}`)), "history changed exact text or numbering");
    passTo(lifecycleOutput, "PASS exact submitted text survives restore ArrowUp execution and listing");

    const healthyName = name("lifecycle-startup-healthy");
    await seedRecord(healthyName, { version: 1, entries: ["echo healthy"] });
    const healthy = createCommandHistoryStore({
      databaseName: healthyName,
      indexedDB: nativeIndexedDB,
      initializationTimeoutMs: 50,
    });
    await healthy.ready;
    equal(healthy.getSnapshot(), ["echo healthy"], "healthy startup restore");

    let lateRequest;
    const late = createCommandHistoryStore({
      databaseName: name("lifecycle-startup-late"),
      initializationTimeoutMs: 50,
      indexedDB: { open() { lateRequest = {}; return lateRequest; } },
    });
    const started = performance.now();
    await late.ready;
    assert(performance.now() - started < 100, "startup fallback exceeded approved budget");
    await late.append("ping");
    equal(late.getSnapshot(), ["ping"], "startup fallback visit memory");
    if (lateRequest && lateRequest.onsuccess) {
      lateRequest.result = { objectStoreNames: { contains: () => true }, close() {} };
      lateRequest.onsuccess();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    equal(late.getSnapshot(), ["ping"], "late initialization changed visit memory");
    passTo(lifecycleOutput, "PASS startup restores before prompt or uses bounded fallback without late mutation");

    await runPendingResizeChecks();
    assert(pendingResizeOutput.textContent.includes("PASS next command and reload retain"), "pending/reset protections failed");
    passTo(lifecycleOutput, "PASS pending execution reset callback activation and rapid-input protections remain intact");

    assert(help["%history%"] === "saved in this browser; newest 200; ArrowUp recalls", "accepted help row changed");
    assert(help["  Exact submitted text"].includes("leading and trailing spaces"), "exact-text help missing");
    assert(help["  Browser storage unavailable"].includes("50 ms"), "fallback help missing");
    passTo(lifecycleOutput, "PASS compatibility and saved-history documentation remain accurate");
  };

  const runWriteExceptionChecks = async () => {
    const errors = [];
    const onError = (event) => {
      errors.push(event.error || event.message || "window error");
      event.preventDefault();
    };
    const onRejection = (event) => {
      errors.push(event.reason || "unhandled rejection");
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    try {
      localStorage.setItem("rootvc.aliases", '[["p","ping"]]');
      localStorage.setItem("rootvc.environment", '{"version":1,"variables":[["KEEP","yes"]]}');
      localStorage.setItem("rootvc.bookmarks", '{"docs":"~/docs"}');
      const unrelatedBefore = ["rootvc.aliases", "rootvc.environment", "rootvc.bookmarks"].map(
        (key) => [key, localStorage.getItem(key)]
      );

      const appendName = name("callback-append");
      const prior = { version: 1, entries: ["ping"] };
      await seedRecord(appendName, prior);
      const appendStore = createCommandHistoryStore({
        databaseName: appendName,
        indexedDB: throwingPutFactory(),
        timeoutMs: 80,
      });
      await appendStore.ready;
      await appendStore.append("echo accepted");
      await appendStore.append("echo next");
      equal(
        appendStore.getSnapshot(),
        ["ping", "echo accepted", "echo next"],
        "append callback failure keeps complete memory"
      );
      equal(await readRecord(appendName), prior, "append callback failure leaves durable record");
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(errors.length === 0, `append callback escaped globally: ${errors}`);
      passTo(writeExceptionOutput, "PASS append callback exception settles without uncaught errors");

      const normalizationName = name("callback-normalization");
      const oversized = Array.from({ length: 201 }, (_, index) => `saved ${index}`);
      const oversizedRecord = { version: 1, entries: oversized };
      await seedRecord(normalizationName, oversizedRecord);
      const normalizationStore = createCommandHistoryStore({
        databaseName: normalizationName,
        indexedDB: throwingPutFactory(),
        timeoutMs: 80,
      });
      await normalizationStore.ready;
      equal(
        normalizationStore.getSnapshot(),
        oversized.slice(-200),
        "normalization callback failure keeps capped memory"
      );
      equal(
        await readRecord(normalizationName),
        oversizedRecord,
        "normalization callback failure leaves durable record"
      );
      passTo(
        writeExceptionOutput,
        "PASS normalization callback exception preserves exact memory and durable arrays"
      );

      appendStore.resetVisit();
      equal(appendStore.getSnapshot(), [], "reset remains owner after failed callback");
      await new Promise((resolve) => setTimeout(resolve, 0));
      equal(appendStore.getSnapshot(), [], "late callback cannot refill reset memory");
      await appendStore.append("echo after reset");
      equal(appendStore.getSnapshot(), ["echo after reset"], "new visit delta remains usable");
      equal(
        ["rootvc.aliases", "rootvc.environment", "rootvc.bookmarks"].map(
          (key) => [key, localStorage.getItem(key)]
        ),
        unrelatedBefore,
        "history failure leaves unrelated browser data unchanged"
      );
      passTo(
        writeExceptionOutput,
        "PASS reset and late events preserve visit ownership and unrelated data"
      );

      const descriptor = Object.getOwnPropertyDescriptor(window, "indexedDB");
      Object.defineProperty(window, "indexedDB", {
        configurable: true,
        value: throwingPutFactory(),
      });
      try {
        const terminal = createTerminal();
        await terminal.historyReady;
        runRootTerminal(terminal);
        await terminal.executeCommandLine("ping", { promptAfter: false });
        assert(terminal.rendered.some((line) => line.includes("pong")), "ping did not render pong");
      } finally {
        if (descriptor) Object.defineProperty(window, "indexedDB", descriptor);
        else delete window.indexedDB;
      }
      assert(errors.length === 0, `storage failure prevented terminal use: ${errors}`);
      passTo(writeExceptionOutput, "PASS next production command remains usable after storage failure");
    } finally {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    }
  };

  const runSubmissionScopeChecks = async () => {
    localStorage.clear();
    window.dataLayer = [];

    const term = createTerminal();
    await term.historyReady;
    runRootTerminal(term);

    await term.executeCommandLine("  echo direct  ", {
      addToHistory: false,
      promptAfter: false,
    });
    await term.executeCommandLine("echo one two | wc -l", {
      addToHistory: false,
      promptAfter: false,
    });
    await term.executeCommandLine("echo unused | head 0", {
      addToHistory: false,
      promptAfter: false,
    });
    await term.executeCommandLine("scope-missing", {
      addToHistory: false,
      promptAfter: false,
    });
    equal(
      term.history,
      [
        "  echo direct  ",
        "echo one two | wc -l",
        "echo unused | head 0",
        "scope-missing",
      ],
      "public suppression option changed submission provenance"
    );
    passTo(submissionScopeOutput, "PASS direct execution records exact submissions regardless of suppression options");

    const historyBeforeInternal = [...term.history];
    const analyticsBeforeInternal = [...window.dataLayer];
    term.deepLink = "echo private-link";
    await term.runDeepLink();
    term.cols = 81;
    await term.resizeListener();
    equal(term.history, historyBeforeInternal, "internal deep-link/redraw entered history");
    assert(
      window.dataLayer.length === analyticsBeforeInternal.length + 1,
      "arrival deep link analytics count changed"
    );
    passTo(submissionScopeOutput, "PASS private redraw and deep links exclude only their own internal execution");

    let releasePreparation;
    const originalPreload = term.preloadCommandAssets;
    term.preloadCommandAssets = (cmd, args) =>
      cmd === "echo" && args[0] === "held"
        ? new Promise((resolve) => { releasePreparation = resolve; })
        : originalPreload(cmd, args);
    const held = term.executeCommandLine("echo held", { promptAfter: false });
    await waitFor(() => typeof releasePreparation === "function", "held submission did not reach preparation");
    const heldHistory = [...term.history];
    term.cols = 82;
    await term.resizeListener();
    equal(term.history, heldHistory, "pending first execution was replayed");
    releasePreparation();
    await held;
    term.preloadCommandAssets = originalPreload;
    passTo(submissionScopeOutput, "PASS pending first execution and completed idle redraw retain distinct ownership");

    const resetTerm = createTerminal(true);
    await resetTerm.historyReady;
    runRootTerminal(resetTerm);
    for (const reset of ["clear", "zsh"]) {
      for (const character of reset) resetTerm.emit(character);
      resetTerm.emit("\r");
      await waitFor(() => resetTerm.currentLine === "", `${reset} did not reach reset input state`);
      for (const character of "ping") resetTerm.emit(character);
      resetTerm.emit("\r");
      await waitFor(
        () => resetTerm.rendered.join("").includes("pong"),
        `${reset} immediate ping did not execute: line=${JSON.stringify(resetTerm.currentLine)} busy=${resetTerm.busy} locked=${resetTerm.locked} history=${JSON.stringify(resetTerm.history)} rendered=${JSON.stringify(resetTerm.rendered.slice(-20))}`
      );
      assert(!resetTerm.rendered.join("").includes("pingnip"), `${reset} corrupted immediate input`);
      resetTerm.rendered.length = 0;
    }
    for (const character of "upgrade") resetTerm.emit(character);
    resetTerm.emit("\r");
    await waitFor(() => !resetTerm.busy && !resetTerm.locked, "upgrade did not release production input");
    for (const character of "ping") resetTerm.emit(character);
    resetTerm.emit("\r");
    await waitFor(() => resetTerm.rendered.join("").includes("pong"), "post-upgrade ping did not execute");
    passTo(submissionScopeOutput, "PASS real xterm clear zsh and upgrade preserve immediate follow-up input");

    resetTerm.rendered.length = 0;
    for (const character of "clear") resetTerm.emit(character);
    resetTerm.emit("\r");
    await waitFor(() => resetTerm.currentLine === "", "editing reset did not reach input state");
    for (const character of "pign") resetTerm.emit(character);
    resetTerm.emit("\u007f");
    resetTerm.emit("\u007f");
    resetTerm.emit("n");
    resetTerm.emit("g");
    resetTerm.emit("\r");
    await waitFor(() => resetTerm.rendered.join("").includes("pong"), "edited reset input did not execute");
    for (const character of "cancelled") resetTerm.emit(character);
    resetTerm.emit("\u0003");
    for (const character of "ping") resetTerm.emit(character);
    resetTerm.emit("\r");
    await waitFor(() => !resetTerm.busy, "edited/reset input did not settle");
    assert(!resetTerm.history.includes("cancelled"), "cancelled input was recorded");
    assert(resetTerm.history.filter((entry) => entry === "ping").length === 2, "edited and next ping ownership changed");
    passTo(submissionScopeOutput, "PASS reset render drain preserves editing cancellation and newer pending input");

    const branchTerm = createTerminal();
    await branchTerm.historyReady;
    runRootTerminal(branchTerm);
    branchTerm.rendered.length = 0;
    await branchTerm.executeCommandLine("ping", { promptAfter: false });
    assert(branchTerm.rendered.join("").includes("pong"), `standalone branch did not produce pong: rendered=${JSON.stringify(branchTerm.rendered.slice(-20))}`);
    await branchTerm.executeCommandLine("history", { promptAfter: false });
    assert(branchTerm.history.length <= 200, "submission scope exceeded retention cap");
    passTo(submissionScopeOutput, "PASS exact recall archive analytics and next-command results remain correct");

    await runExecutionTimingChecks(executionFixture);
    await runLifecycleRepairChecks();
    passTo(submissionScopeOutput, "PASS activation interactive continuation and earlier lifecycle protections remain intact");
  };

  submissionScopeButton.addEventListener("click", async () => {
    submissionScopeButton.disabled = true;
    submissionScopeOutput.replaceChildren();
    try {
      await runSubmissionScopeChecks();
      passTo(submissionScopeOutput, "SUBMISSION SCOPE CHECKS COMPLETE");
    } catch (error) {
      passTo(submissionScopeOutput, `FAIL ${error && error.stack ? error.stack : error}`);
    }
  });

  Promise.all([executionFixtureReady]).then(() => {
    submissionScopeStatus.textContent = "READY";
    submissionScopeButton.disabled = false;
  });

  executionTimingButton.addEventListener("click", async () => {
    executionTimingButton.disabled = true;
    executionTimingOutput.replaceChildren();
    try {
      await runExecutionTimingChecks(executionFixture);
      passTo(executionTimingOutput, "EXECUTION TIMING CHECKS COMPLETE");
    } catch (error) {
      passTo(executionTimingOutput, `FAIL ${error && error.stack ? error.stack : error}`);
    }
  });

  pendingResizeButton.addEventListener("click", async () => {
    pendingResizeButton.disabled = true;
    pendingResizeOutput.replaceChildren();
    try {
      await runPendingResizeChecks();
      passTo(pendingResizeOutput, "PENDING RESIZE CHECKS COMPLETE");
    } catch (error) {
      passTo(pendingResizeOutput, `FAIL ${error && error.stack ? error.stack : error}`);
    }
  });

  lifecycleButton.addEventListener("click", async () => {
    lifecycleButton.disabled = true;
    lifecycleOutput.replaceChildren();
    pendingResizeOutput.replaceChildren();
    try {
      await runLifecycleRepairChecks();
      passTo(lifecycleOutput, "LIFECYCLE REPAIR CHECKS COMPLETE");
    } catch (error) {
      passTo(lifecycleOutput, `FAIL ${error && error.stack ? error.stack : error}`);
    }
  });

  writeExceptionButton.addEventListener("click", async () => {
    writeExceptionButton.disabled = true;
    writeExceptionOutput.replaceChildren();
    try {
      await runWriteExceptionChecks();
      passTo(writeExceptionOutput, "WRITE EXCEPTION CHECKS COMPLETE");
    } catch (error) {
      passTo(writeExceptionOutput, `FAIL ${error && error.stack ? error.stack : error}`);
    }
  });

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

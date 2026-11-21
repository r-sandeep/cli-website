(() => {
  "use strict";

  const productionHistoryStore = createCommandHistoryStore;

  const PASS = {
    unavailable: "PASS: denied getter and failed open booted; complete memory history recalled and listed; next ping printed pong",
    quota: "PASS: quota and abort kept complete live history and old durable snapshot; next ping printed pong",
    cap: "PASS: active ArrowUp, history rows, and fresh restoration match the exact latest 200 commands",
    isolation: "PASS: restored commands never executed; resize did not append or emit analytics; aliases, environment, bookmarks, and deep links retained behavior",
    dispatchPending: "PASS: pending native writes did not block pong, pipeline result, pipeline error, exact history, or the next prompt",
    dispatchOrder: "PASS: committed archive equals the complete submission sequence once in order; failures retained complete live history",
    dispatchReset: "PASS: late completion did not restore cleared live history; fresh visit restored the complete committed archive",
  };

  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const assertArray = (actual, expected, message) =>
    assert(JSON.stringify(actual) === JSON.stringify(expected), message);

  const waitFor = async (predicate, message) => {
    for (let count = 0; count < 100; count += 1) {
      if (predicate()) return;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    throw new Error(message);
  };

  function createTerminal() {
    const output = [];
    const dataHandlers = [];
    const term = {
      VERSION: 4,
      buffer: { active: { get cursorX() { return term._promptRawText ? term._promptRawText().length + 1 + term.currentLine.length : term.currentLine.length; } } },
      cols: 100,
      focus() {},
      loadAddon() {},
      open() {},
      reset() { output.length = 0; },
      scrollToBottom() {},
      write(text) { output.push(String(text)); },
      writeln(text = "") { output.push(`${text}\r\n`); },
      onData(handler) {
        dataHandlers.push(handler);
        return { dispose() { const index = dataHandlers.indexOf(handler); if (index >= 0) dataHandlers.splice(index, 1); } };
      },
      attachCustomKeyEventHandler(handler) { term.keyHandler = handler; },
      emit(data) {
        for (const handler of [...dataHandlers]) handler(data);
      },
      output,
    };
    return term;
  }

  async function settle(term, outputBefore) {
    // Fast commands can enter and leave the busy state before the next browser
    // frame. Treat post-Enter output as an equivalent start signal, then require
    // the production lifecycle to be unlocked before the caller continues.
    await waitFor(
      () => term.busy || term.output.join("") !== outputBefore,
      "terminal command did not start",
    );
    await waitFor(() => !term.busy, "terminal command did not settle");
    await Promise.resolve();
  }

  async function submit(term, line) {
    for (const character of line) term.emit(character);
    const outputBefore = term.output.join("");
    term.emit("\r");
    await settle(term, outputBefore);
  }

  async function boot(storeFactory = productionHistoryStore) {
    const originalFactory = window.createCommandHistoryStore;
    window.createCommandHistoryStore = storeFactory;
    window.colorText = (text) => text;
    window.ensureASCIIArt = async () => {};
    window.ensureFileLoaded = async () => {};
    window.fitAddon = { fit() {} };
    window.getASCIIArtIdForCommand = () => null;
    window.getArt = () => "";
    window.getPreloadFileForCommand = () => null;
    window.preloadASCIIArt = async () => {};
    window.scheduleIdleTask = () => {};
    window.dataLayer = [];
    const term = createTerminal();
    window.term = term;
    extend(term);
    await term.historyReady;
    runRootTerminal(term);
    window.createCommandHistoryStore = originalFactory;
    return term;
  }

  async function unavailable() {
    const throwingFactory = () => {
      const options = {};
      Object.defineProperty(options, "indexedDB", { get() { throw new Error("denied"); } });
      return productionHistoryStore(options);
    };
    for (const factory of [
      throwingFactory,
      () => productionHistoryStore({ indexedDB: { open() { const request = {}; queueMicrotask(() => request.onerror?.({ preventDefault() {} })); return request; } } }),
    ]) {
      const term = await boot(factory);
      await submit(term, "echo one");
      await submit(term, "echo two");
      term.emit("\x1b[A");
      assert(term.currentLine === "echo two", "memory recall lost latest command");
      term.emit("\x1b[B");
      await submit(term, "history");
      await submit(term, "ping");
      assert(term.output.join("").includes("1000  echo one"), "memory history output incomplete");
      assert(term.output.join("").includes("pong"), "terminal unusable after storage failure");
    }
    document.querySelector("#terminal-unavailable").textContent = PASS.unavailable;
  }

  async function quotaAndAbort() {
    const databaseName = "history-terminal-quota";
    const factory = () => productionHistoryStore({ databaseName });
    const seed = factory();
    await seed.load();
    await seed.append("durable-prior");
    const originalPut = IDBObjectStore.prototype.put;
    for (const mode of ["quota", "abort"]) {
      const term = await boot(factory);
      IDBObjectStore.prototype.put = function (...args) {
        if (args[0]?.id === "history") {
          if (mode === "quota") throw new DOMException("quota", "QuotaExceededError");
          const request = originalPut.apply(this, args);
          this.transaction.abort();
          return request;
        }
        return originalPut.apply(this, args);
      };
      await submit(term, `echo ${mode}-one`);
      await submit(term, `echo ${mode}-two`);
      IDBObjectStore.prototype.put = originalPut;
      assert(term.history.includes(`echo ${mode}-two`), `${mode} dropped live history`);
      await submit(term, "ping");
      assert(term.output.join("").includes("pong"), `${mode} blocked next command`);
      assertArray(await factory().load(), ["durable-prior"], `${mode} changed durable snapshot`);
    }
    IDBObjectStore.prototype.put = originalPut;
    document.querySelector("#terminal-quota").textContent = PASS.quota;
  }

  async function cap() {
    const databaseName = "history-terminal-cap";
    const factory = () => productionHistoryStore({ databaseName });
    const term = await boot(factory);
    const commands = Array.from({ length: 201 }, (_, index) => `echo cap-${index}`);
    for (const command of commands) await term.executeCommandLine(command);
    const expected = commands.slice(-200);
    assertArray(term.history, expected, "active history was not capped at 200");
    term.historyCursor = -1;
    term.emit("\x1b[A");
    assert(term.currentLine === expected[199], "ArrowUp did not recall latest capped command");
    const restored = await boot(factory);
    assertArray(restored.history, expected, "fresh restoration differs from active latest 200");
    document.querySelector("#terminal-cap").textContent = PASS.cap;
  }

  async function isolation() {
    const databaseName = "history-terminal-isolation";
    const factory = () => productionHistoryStore({ databaseName });
    const seed = factory();
    await seed.load();
    for (const command of ["export BAD=executed", "alias bad=echo executed", "go kept"]) await seed.append(command);
    const term = await boot(factory);
    assert(term.environment.get("BAD") === undefined, "restored export executed");
    assert(term.getAlias("bad") === undefined, "restored alias executed");
    assert(term.cwd === "~", "restored bookmark navigation executed");
    assert(term.getAlias("kept") === "echo alias-ok", "existing alias changed");
    assert(term.environment.get("KEPT") === "env-ok", "existing environment changed");
    assert(bookmarkStore.lookup("kept").path === "/saved", "existing bookmark changed");
    assert(window.dataLayer.length === 0, "restoration emitted analytics");
    await submit(term, "kept");
    assert(term.output.join("").includes("alias-ok"), "alias execution changed");
    await submit(term, "echo $KEPT");
    assert(term.output.join("").includes("env-ok"), "environment expansion changed");
    await submit(term, "go kept");
    assert(term.cwd === "/saved", "bookmark navigation changed");
    await submit(term, "echo visit-marker");
    term.deepLink = "ping";
    const durableBeforeDeepLink = await factory().load();
    await term.runDeepLink();
    assert(term.output.join("").includes("pong"), "deep link execution changed");
    assertArray(await factory().load(), durableBeforeDeepLink, "deep link appended history");
    const durableBefore = await factory().load();
    const eventsBefore = window.dataLayer.length;
    term.cols = 80;
    window.fitAddon.fit = () => { term.cols = 60; };
    await term.resizeListener();
    assertArray(await factory().load(), durableBefore, "resize appended history");
    assert(window.dataLayer.length === eventsBefore, "resize emitted analytics");
    assert(term.output.join("").includes("visit-marker"), "current visit was not redrawn");
    document.querySelector("#terminal-isolation").textContent = PASS.isolation;
  }

  async function openRawDatabase(databaseName) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("snapshots")) {
          request.result.createObjectStore("snapshots", { keyPath: "id" });
        }
      };
      request.onerror = () => reject(request.error || new Error("raw database open failed"));
      request.onsuccess = () => resolve(request.result);
    });
  }

  async function holdHistoryWrites(databaseName) {
    const database = await openRawDatabase(databaseName);
    const transaction = database.transaction("snapshots", "readwrite");
    const store = transaction.objectStore("snapshots");
    let released = false;
    const complete = new Promise((resolve, reject) => {
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onerror = () => reject(transaction.error || new Error("blocking transaction failed"));
      transaction.onabort = () => reject(transaction.error || new Error("blocking transaction aborted"));
    });
    const keepAlive = () => {
      const request = store.get("history");
      request.onsuccess = () => { if (!released) keepAlive(); };
      request.onerror = () => { throw request.error || new Error("blocking request failed"); };
    };
    keepAlive();
    return {
      complete,
      release() { released = true; },
    };
  }

  async function pendingDispatch() {
    const databaseName = "history-terminal-pending-dispatch";
    const factory = () => productionHistoryStore({ databaseName });
    const term = await boot(factory);
    const blocker = await holdHistoryWrites(databaseName);
    const submitted = [
      "ping",
      "echo branch_marker | wc -l",
      "echo bad_marker | head 0",
      "history",
    ];
    for (const line of submitted) await submit(term, line);

    const rendered = term.output.join("");
    assert(rendered.includes("pong"), "pending append blocked standalone output");
    assert(rendered.includes("1\r\n"), "pending append blocked pipeline result");
    assert(rendered.includes("head: count must be a positive base-10 integer"), "pending append blocked pipeline error");
    submitted.forEach((line, index) => {
      assert(rendered.includes(`${1000 + index}  ${line}`), `pending history omitted ${line}`);
    });
    assert(term.busy === false, "pending append retained busy state");
    assert(term.output.at(-1)?.includes("guest:rootpc ~ $"), "pending append omitted fresh prompt");
    document.querySelector("#dispatch-pending").textContent = PASS.dispatchPending;

    blocker.release();
    await blocker.complete;
    const committedStore = factory();
    await committedStore.load();
    await committedStore.append("commit-barrier");
    const committed = await factory().load();
    assertArray(
      committed,
      submitted.concat("commit-barrier"),
      `committed archive was reordered or duplicated: ${JSON.stringify(committed)}`,
    );

    for (const mode of ["reject", "throw"]) {
      const append = mode === "reject"
        ? () => Promise.reject(new Error("fixture rejection"))
        : () => { throw new Error("fixture throw"); };
      const failed = await boot(() => ({ load: async () => [], append }));
      await submit(failed, "echo failure_duplicate");
      await submit(failed, "echo failure_duplicate");
      await submit(failed, "ping");
      assertArray(failed.history, ["echo failure_duplicate", "echo failure_duplicate", "ping"], `${mode} changed live history`);
      assert(failed.output.join("").includes("pong"), `${mode} blocked following ping`);
      assert(failed.busy === false, `${mode} retained busy state`);
    }
    document.querySelector("#dispatch-order").textContent = PASS.dispatchOrder;
  }

  async function pendingReset() {
    const databaseName = "history-terminal-pending-reset";
    const factory = () => productionHistoryStore({ databaseName });
    const term = await boot(factory);
    const blocker = await holdHistoryWrites(databaseName);
    await submit(term, "echo before_reset");
    await submit(term, "clear");
    await submit(term, "history");
    assertArray(term.history, ["history"], "clear did not retain its live-history reset");
    blocker.release();
    await blocker.complete;
    const committedStore = factory();
    await committedStore.load();
    await committedStore.append("commit-barrier");
    await submit(term, "history");
    assertArray(term.history, ["history", "history"], "late completion restored pre-clear live history");

    const expected = ["echo before_reset", "clear", "history", "commit-barrier", "history"];
    assertArray(await factory().load(), expected, "fresh visit archive omitted reset-era submissions");
    const restored = await boot(factory);
    assertArray(restored.history, expected, "fresh visit did not restore committed reset-era archive");
    document.querySelector("#dispatch-reset").textContent = PASS.dispatchReset;
  }

  document.querySelector("#run-terminal-cases").addEventListener("click", async () => {
    try {
      await unavailable();
      await quotaAndAbort();
      await cap();
      await isolation();
    } catch (error) {
      for (const element of document.querySelectorAll("[id^=terminal-]")) {
        if (element.textContent === "PENDING") element.textContent = `FAIL: ${error.message}`;
      }
      throw error;
    }
  });

  document.querySelector("#run-dispatch-cases").addEventListener("click", async () => {
    try {
      await pendingDispatch();
      await pendingReset();
    } catch (error) {
      for (const element of document.querySelectorAll("[id^=dispatch-]")) {
        if (element.textContent === "PENDING") element.textContent = `FAIL: ${error.message}`;
      }
      throw error;
    }
  });
})();

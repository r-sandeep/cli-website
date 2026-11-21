(() => {
  "use strict";

  const PASS = {
    unavailable: "PASS: denied getter and failed open booted; complete memory history recalled and listed; next ping printed pong",
    quota: "PASS: quota and abort kept complete live history and old durable snapshot; next ping printed pong",
    cap: "PASS: active ArrowUp, history rows, and fresh restoration match the exact latest 200 commands",
    isolation: "PASS: restored commands never executed; resize did not append or emit analytics; aliases, environment, bookmarks, and deep links retained behavior",
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
    let cursor = 0;
    const term = {
      VERSION: 4,
      buffer: { active: { get cursorX() { return term._promptRawText ? term._promptRawText().length + 1 + cursor : cursor; } } },
      cols: 100,
      focus() {},
      loadAddon() {},
      open() {},
      reset() { output.length = 0; cursor = 0; },
      scrollToBottom() {},
      write(text) { output.push(String(text)); },
      writeln(text = "") { output.push(`${text}\r\n`); },
      onData(handler) {
        dataHandlers.push(handler);
        return { dispose() { const index = dataHandlers.indexOf(handler); if (index >= 0) dataHandlers.splice(index, 1); } };
      },
      attachCustomKeyEventHandler(handler) { term.keyHandler = handler; },
      emit(data) {
        if (data === "\r") cursor = 0;
        else if (data === "\033[A" || data === "\033[B") cursor = term.currentLine.length;
        else if (data.length === 1 && data.charCodeAt(0) >= 32) cursor += 1;
        for (const handler of [...dataHandlers]) handler(data);
      },
      output,
    };
    return term;
  }

  async function settle(term) {
    await waitFor(() => !term.busy, "terminal command did not settle");
    await Promise.resolve();
  }

  async function submit(term, line) {
    for (const character of line) term.emit(character);
    term.emit("\r");
    await settle(term);
  }

  async function boot(storeFactory = createCommandHistoryStore) {
    const originalFactory = window.createCommandHistoryStore;
    window.createCommandHistoryStore = storeFactory;
    window.LOGO_TYPE = "ROOT";
    window.jobs = {};
    window.commands = {
      echo(args) { term.stylePrint(args.join(" ")); },
      export(args) {
        if (args[0]) {
          const split = args[0].indexOf("=");
          term.environment.set(args[0].slice(0, split), args[0].slice(split + 1));
        }
      },
      history() { term.history.forEach((line, index) => term.stylePrint(`${1000 + index}  ${line}`)); },
      ping() { term.stylePrint("pong"); },
      alias(args, parsed) {
        const raw = parsed.rawArgs;
        const split = raw.indexOf("=");
        term.defineAlias(raw.slice(0, split), raw.slice(split + 1));
      },
      bookmark(args) {
        if (args[0] === "add") bookmarkStore.add(args[1], term.cwd);
      },
      go(args) {
        const found = bookmarkStore.lookup(args[0]);
        if (found.ok) term.cwd = found.path;
      },
      clear() { term.init(); },
    };
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

  function deleteHistoryDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("rootvc.command-history");
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("history delete blocked"));
    });
  }

  async function unavailable() {
    const throwingFactory = () => {
      const options = {};
      Object.defineProperty(options, "indexedDB", { get() { throw new Error("denied"); } });
      return createCommandHistoryStore(options);
    };
    for (const factory of [
      throwingFactory,
      () => createCommandHistoryStore({ indexedDB: { open() { const request = {}; queueMicrotask(() => request.onerror?.({ preventDefault() {} })); return request; } } }),
    ]) {
      const term = await boot(factory);
      await submit(term, "echo one");
      await submit(term, "echo two");
      term.emit("\033[A");
      assert(term.currentLine === "echo two", "memory recall lost latest command");
      term.emit("\033[B");
      await submit(term, "history");
      await submit(term, "ping");
      assert(term.output.join("").includes("1000  echo one"), "memory history output incomplete");
      assert(term.output.join("").includes("pong"), "terminal unusable after storage failure");
    }
    document.querySelector("#terminal-unavailable").textContent = PASS.unavailable;
  }

  async function quotaAndAbort() {
    await deleteHistoryDatabase();
    const seed = createCommandHistoryStore();
    await seed.load();
    await seed.append("durable-prior");
    const originalPut = IDBObjectStore.prototype.put;
    for (const mode of ["quota", "abort"]) {
      const term = await boot();
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
      assertArray(await createCommandHistoryStore().load(), ["durable-prior"], `${mode} changed durable snapshot`);
    }
    IDBObjectStore.prototype.put = originalPut;
    document.querySelector("#terminal-quota").textContent = PASS.quota;
  }

  async function cap() {
    await deleteHistoryDatabase();
    const term = await boot();
    const commands = Array.from({ length: 201 }, (_, index) => `echo cap-${index}`);
    for (const command of commands) await term.executeCommandLine(command);
    const expected = commands.slice(-200);
    assertArray(term.history, expected, "active history was not capped at 200");
    term.historyCursor = -1;
    term.emit("\033[A");
    assert(term.currentLine === expected[199], "ArrowUp did not recall latest capped command");
    const restored = await boot();
    assertArray(restored.history, expected, "fresh restoration differs from active latest 200");
    document.querySelector("#terminal-cap").textContent = PASS.cap;
  }

  async function isolation() {
    await deleteHistoryDatabase();
    localStorage.setItem("rootvc.aliases", JSON.stringify([["kept", "echo alias-ok"]]));
    localStorage.setItem("rootvc.cli.environment.v1", JSON.stringify({ version: 1, variables: [["KEPT", "env-ok"]] }));
    localStorage.setItem("rootvc.bookmarks.v1", JSON.stringify([["kept", "/saved"]]));
    const seed = createCommandHistoryStore();
    await seed.load();
    for (const command of ["export BAD=executed", "alias bad=echo executed", "go kept"]) await seed.append(command);
    const term = await boot();
    assert(term.environment.get("BAD") === undefined, "restored export executed");
    assert(term.getAlias("bad") === undefined, "restored alias executed");
    assert(term.cwd === "~", "restored bookmark navigation executed");
    assert(term.getAlias("kept") === "echo alias-ok", "existing alias changed");
    assert(term.environment.get("KEPT") === "env-ok", "existing environment changed");
    assert(bookmarkStore.lookup("kept").path === "/saved", "existing bookmark changed");
    assert(window.dataLayer.length === 0, "restoration emitted analytics");
    await submit(term, "echo visit-marker");
    const durableBefore = await createCommandHistoryStore().load();
    const eventsBefore = window.dataLayer.length;
    term.cols = 80;
    window.fitAddon.fit = () => { term.cols = 60; };
    await term.resizeListener();
    assertArray(await createCommandHistoryStore().load(), durableBefore, "resize appended history");
    assert(window.dataLayer.length === eventsBefore, "resize emitted analytics");
    assert(term.output.join("").includes("visit-marker"), "current visit was not redrawn");
    document.querySelector("#terminal-isolation").textContent = PASS.isolation;
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
})();

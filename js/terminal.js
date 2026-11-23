function _longestCommonCompletionPrefix(candidates) {
  if (candidates.length === 0) return "";

  const first = candidates[0];
  const folded = candidates.map((candidate) => candidate.toLowerCase());
  let length = first.length;
  for (const candidate of folded) {
    let index = 0;
    while (
      index < length &&
      index < candidate.length &&
      first[index].toLowerCase() === candidate[index]
    ) {
      index++;
    }
    length = index;
  }
  return first.slice(0, length);
}

function _completionForLine(line) {
  const firstWord = line.match(/^(\S*)$/);
  if (firstWord) {
    return { prefix: "", token: firstWord[1], candidates: Object.keys(commands) };
  }

  const argument = line.match(/^(\S+)(\s+)(\S*)$/);
  if (!argument) return null;

  const command = argument[1].toLowerCase();
  let candidates;
  if (command === "whois") candidates = Object.keys(team);
  else if (command === "tldr") candidates = Object.keys(portfolio);
  else if (["cd", "ls", "cat", "head", "tail", "less", "more"].includes(command)) {
    candidates = _filesHere();
  } else {
    return null;
  }

  return {
    prefix: `${argument[1]}${argument[2]}`,
    token: argument[3],
    candidates,
  };
}

function _completionRows(candidates, width) {
  const gap = 2;
  const columnWidth = Math.max(...candidates.map((candidate) => candidate.length)) + gap;
  const columns = Math.max(1, Math.floor(width / columnWidth));
  const rows = [];
  for (let index = 0; index < candidates.length; index += columns) {
    rows.push(
      candidates
        .slice(index, index + columns)
        .map((candidate, column, row) =>
          column === row.length - 1 ? candidate : candidate.padEnd(columnWidth, " ")
        )
        .join("")
    );
  }
  return rows;
}

function runRootTerminal(term, inputHandoff = null) {
  if (term._initialized) {
    return;
  }

  // Saved recall is restored before this function is entered. Preserve it while
  // drawing the first visit so ArrowUp and history are ready at the first prompt.
  term.init("guest", true);
  term._initialized = true;
  term.locked = false;

  term.prompt();
  term.runDeepLink();

  let resizeState = "idle";
  let resizePending = false;
  const scheduleResize = () => {
    resizeState = "scheduled";
    window.requestAnimationFrame(() => {
      resizeState = "running";

      let replay;
      try {
        replay = Promise.resolve(term.resizeListener());
      } catch (error) {
        replay = Promise.reject(error);
      }

      replay
        .catch((error) => {
          console.error("Resize replay failed", error);
        })
        .finally(() => {
          if (resizePending) {
            resizePending = false;
            scheduleResize();
          } else {
            resizeState = "idle";
          }
        });
    });
  };
  window.addEventListener(
    "resize",
    () => {
      if (resizeState === "running") {
        resizePending = true;
        return;
      }

      if (resizeState === "idle") {
        scheduleResize();
      }
    },
    { passive: true }
  );

  const previousWordStart = (line, cursor) => {
    let nextCursor = cursor;
    while (nextCursor > 0 && line[nextCursor - 1] === " ") nextCursor--;
    while (nextCursor > 0 && line[nextCursor - 1] !== " ") nextCursor--;
    return nextCursor;
  };

  const nextWordStart = (line, cursor) => {
    let nextCursor = cursor;
    while (nextCursor < line.length && line[nextCursor] !== " ") nextCursor++;
    while (nextCursor < line.length && line[nextCursor] === " ") nextCursor++;
    return nextCursor;
  };

  const updateInput = (line, cursor) => {
    const oldLine = term.currentLine;
    const oldCursor = term.pos();
    if (line === oldLine && cursor === oldCursor) return;

    if (oldCursor > 0) term.write("\x1b[D".repeat(oldCursor));
    term.currentLine = line;
    term.write(`${line}\x1b[K`);
    if (cursor < line.length) {
      term.write("\x1b[D".repeat(line.length - cursor));
    }
  };

  const editInput = (action) => {
    const line = term.currentLine;
    const cursor = Math.max(0, Math.min(term.pos(), line.length));

    switch (action) {
      case "previousWord":
        updateInput(line, previousWordStart(line, cursor));
        break;
      case "nextWord":
        updateInput(line, nextWordStart(line, cursor));
        break;
      case "deletePreviousWord": {
        const start = previousWordStart(line, cursor);
        updateInput(line.slice(0, start) + line.slice(cursor), start);
        break;
      }
      case "deleteNextWord": {
        const end = nextWordStart(line, cursor);
        updateInput(line.slice(0, cursor) + line.slice(end), cursor);
        break;
      }
      case "lineStart":
        updateInput(line, 0);
        break;
      case "lineEnd":
        updateInput(line, line.length);
        break;
      case "clearLine":
        updateInput("", 0);
        break;
    }
  };

  const shortcutForEvent = (event) => {
    if (
      event.type !== "keydown" ||
      event.shiftKey ||
      event.metaKey ||
      event.altKey === event.ctrlKey
    ) {
      return null;
    }

    if (event.altKey) {
      if (event.key === "ArrowLeft") return "previousWord";
      if (event.key === "ArrowRight") return "nextWord";
      if (
        event.code === "KeyD" ||
        (!event.code && event.key.toLowerCase() === "d")
      ) {
        return "deleteNextWord";
      }
    }

    if (event.ctrlKey) {
      if (event.key.toLowerCase() === "w") return "deletePreviousWord";
      if (event.key.toLowerCase() === "a") return "lineStart";
      if (event.key.toLowerCase() === "e") return "lineEnd";
      if (event.key.toLowerCase() === "u") return "clearLine";
    }

    return null;
  };

  let completionState = null;
  const resetCompletion = () => {
    completionState = null;
    // Keep the legacy fields inert for callers that still initialize them.
    term.tabIndex = 0;
    term.tabOptions = [];
    term.tabBase = "";
  };

  const completeInput = () => {
    if (
      !term._initialized ||
      term.locked ||
      term.busy ||
      term.currentLine.length === 0 ||
      term.pos() !== term.currentLine.length
    ) {
      resetCompletion();
      return false;
    }

    const completion = _completionForLine(term.currentLine);
    if (!completion) {
      resetCompletion();
      return false;
    }

    const foldedToken = completion.token.toLowerCase();
    const matches = completion.candidates.filter((candidate) =>
      candidate.toLowerCase().startsWith(foldedToken)
    );
    if (matches.length === 0) {
      resetCompletion();
      return false;
    }

    if (matches.length === 1) {
      term.setCurrentLine(`${completion.prefix}${matches[0]} `);
      resetCompletion();
      return true;
    }

    const commonPrefix = _longestCommonCompletionPrefix(matches);
    const completedLine = `${completion.prefix}${commonPrefix}`;
    if (completedLine !== term.currentLine) {
      term.setCurrentLine(completedLine);
      completionState = {
        line: completedLine,
        candidates: matches,
      };
      return true;
    }

    const sameCandidates =
      completionState &&
      completionState.line === term.currentLine &&
      completionState.candidates.length === matches.length &&
      completionState.candidates.every((candidate, index) => candidate === matches[index]);
    if (!sameCandidates) {
      completionState = { line: term.currentLine, candidates: matches };
      return false;
    }

    const width = Number.isFinite(term.cols) ? term.cols : 80;
    term.write(`\r\n${_completionRows(matches, width).join("\r\n")}`);
    term.prompt();
    term.write(term.currentLine);
    return true;
  };

  term.attachCustomKeyEventHandler((event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      if (
        event.type === "keydown" &&
        !term.locked &&
        term.bufferResetInput?.({ lifecycleCompletion: true })
      ) {
        return false;
      }
      // xterm asks about both phases in some browsers. Complete exactly once,
      // but consume every Tab phase so focus cannot move and no tab reaches
      // onData as input.
      if (event.type === "keydown" && completeInput()) {
        term.scrollToBottom();
      }
      return false;
    }

    if (event.type === "keydown") resetCompletion();
    const action = shortcutForEvent(event);
    if (!action) return true;

    event.preventDefault();
    if (term._initialized && !term.locked && !term.busy) {
      editInput(action);
      term.scrollToBottom();
    }
    return false;
  });

  const processInput = (e) => {
    // Reset commands replace xterm's buffer while its parser is still draining
    // writes. The terminal extension owns that narrow transition and returns
    // queued bytes here, so editing, control keys and Enter use this exact same
    // production path rather than a second input algorithm.
    if (!term.locked && term.bufferResetInput?.(e)) return;
    if (term._initialized && !term.locked && !term.busy) {
      if (e?.lifecycleCompletion) {
        if (completeInput()) term.scrollToBottom();
        return;
      }
      if (e !== "\t") resetCompletion();
      switch (e) {
        case "\r": // Enter
          // Reset tab state
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";
          term.executeCommandLine(term.currentLine);
          break;
        case "\u0001": // Ctrl+A
          term.write("\x1b[D".repeat(term.pos()));
          break;
        case "\u0005": // Ctrl+E
          if (term.pos() < term.currentLine.length) {
            term.write("\x1b[C".repeat(term.currentLine.length - term.pos()));
          }
          break;
        case "\u0003": // Ctrl+C
          // Reset tab state
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";

          term.prompt();
          term.clearCurrentLine(true);
          break;
        case "\u0008": // Ctrl+H
        case "\u007F": // Backspace (DEL)
          // Reset tab state
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";

          // Do not delete the prompt
          if (term.pos() > 0) {
            const newLine =
              term.currentLine.slice(0, term.pos() - 1) +
              term.currentLine.slice(term.pos());
            term.setCurrentLine(newLine, true);
          }
          break;
        case "\033[A": // up
          // Reset tab state
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";

          var h = [...term.history].reverse();
          if (term.historyCursor < h.length - 1) {
            term.historyCursor += 1;
            term.setCurrentLine(h[term.historyCursor], false);
          }
          break;
        case "\033[B": // down
          // Reset tab state
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";

          var h = [...term.history].reverse();
          if (term.historyCursor > 0) {
            term.historyCursor -= 1;
            term.setCurrentLine(h[term.historyCursor], false);
          } else {
            term.clearCurrentLine(true);
          }
          break;
        case "\033[C": // right
          if (term.pos() < term.currentLine.length) {
            term.write("\x1b[C");
          }
          break;
        case "\033[D": // left
          if (term.pos() > 0) {
            term.write("\x1b[D");
          }
          break;
        case "\t": // tab
          // Browser Tab keydowns are consumed by the custom key handler above.
          // If xterm still forwards one, keep it fully inert.
          return;
        default: // Print all other characters
          // Reset tab state on any other key
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";

          // Optimize: just write the character instead of redrawing entire line
          if (e.length === 1 && e.charCodeAt(0) >= 32) {
            const pos = term.pos();
            const restOfLine = term.currentLine.slice(pos);
            term.currentLine = term.currentLine.slice(0, pos) + e + restOfLine;
            term.write(e);
            if (restOfLine.length > 0) {
              term.write(restOfLine);
              term.write("\x1b[D".repeat(restOfLine.length));
            }
          }
          break;
      }
      term.scrollToBottom();
    }
  };

  const lifecycleInput = inputHandoff?.pendingInput || [];
  let lifecycleDraining = false;
  const drainLifecycleInput = () => {
    if (term.locked) {
      // Form answers and upgrade-era bytes belong to their existing owner (or
      // are deliberately discarded). Never retain an already-admitted shell
      // tail until that ownership ends.
      lifecycleInput.length = 0;
      lifecycleDraining = false;
      return;
    }
    if (lifecycleDraining || term.busy || lifecycleInput.length === 0) {
      return;
    }
    lifecycleDraining = true;
    const next = () => {
      if (term.locked) {
        lifecycleInput.length = 0;
        lifecycleDraining = false;
        return;
      }
      if (term.busy || lifecycleInput.length === 0) {
        lifecycleDraining = false;
        return;
      }
      processInput(lifecycleInput.shift());
      // Cursor-dependent input must observe all writes caused by the preceding
      // event. xterm's empty-write callback is a parser completion barrier.
      term.write("", next);
    };
    next();
  };

  term.setResetInputDrainer?.((queued) => {
    lifecycleInput.push(...queued);
    drainLifecycleInput();
  });
  term.setLifecycleInputResumer?.(drainLifecycleInput);

  if (inputHandoff) {
    inputHandoff.setReceiver((data) => {
      // collectInput has its own onData subscription, while upgrade's lock
      // intentionally discards input. In either case the shell receiver must
      // not retain the event for execution after ownership ends.
      if (term.locked) return;

      // During a reset-render transition, preserve arrival order in the
      // transition-owned queue. Routing a byte through lifecycleInput first
      // would let the reset barrier reappend it behind newer bytes that have
      // already arrived, producing cursor-corrupt permutations such as ingp.
      if (term.bufferResetInput?.(data)) return;

      // Only startup/reset input already owned by the lifecycle FIFO may join
      // that FIFO. Ordinary live input keeps the established processInput busy
      // gate instead of becoming a general deferred command queue.
      if (lifecycleDraining || lifecycleInput.length > 0) {
        if (term.busy) return;
        lifecycleInput.push(data);
        drainLifecycleInput();
        return;
      }
      processInput(data);
    });
    // The first prompt must be parsed before captured startup input reaches the
    // production editor. Reception itself was installed synchronously.
    term.write("", drainLifecycleInput);
  } else {
    term.onData(processInput);
  }
}

function colorText(text, color) {
  const colors = {
    command: "\x1b[1;35m",
    hyperlink: "\x1b[1;34m",
    user: "\x1b[1;33m",
    prompt: "\x1b[1;32m",
    bold: "\x1b[1;37m",
  };
  return `${colors[color] || ""}${text}\x1b[0;38m`;
}

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

function runRootTerminal(term) {
  if (term._initialized) {
    return;
  }

  term.init();
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

      let resize;
      try {
        resize = Promise.resolve(term.resizeListener());
      } catch (error) {
        resize = Promise.reject(error);
      }

      resize
        .catch((error) => {
          console.error("Resize handling failed", error);
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
    term.renderInput(line, cursor);
  };

  const normalInputAvailable = () =>
    term._initialized &&
    !term.locked &&
    !term.busy &&
    !window.rootTui?.active;

  const newestHistoryMatch = (query, beforeIndex = term.history.length) => {
    const foldedQuery = query.toLowerCase();
    for (let index = beforeIndex - 1; index >= 0; index--) {
      if (term.history[index].toLowerCase().includes(foldedQuery)) return index;
    }
    return null;
  };

  const startHistorySearch = () => {
    term.historySearch = {
      savedDraft: term.currentLine,
      savedCursor: term.pos(),
      query: "",
      selectedHistoryIndex: newestHistoryMatch(""),
    };
    term.renderHistorySearch(term.historySearch);
  };

  const repeatHistorySearch = () => {
    const state = term.historySearch;
    if (!state) {
      startHistorySearch();
      return;
    }
    if (Number.isInteger(state.selectedHistoryIndex)) {
      state.selectedHistoryIndex = newestHistoryMatch(
        state.query,
        state.selectedHistoryIndex
      );
    }
    term.renderHistorySearch(state);
  };

  const updateHistorySearchQuery = (query) => {
    const state = term.historySearch;
    state.query = query;
    state.selectedHistoryIndex = newestHistoryMatch(query);
    term.renderHistorySearch(state);
  };

  const cancelHistorySearch = () => {
    const state = term.historySearch;
    if (!state) return;
    term.historySearch = null;
    term.renderInput(state.savedDraft, state.savedCursor);
  };

  const acceptHistorySearch = () => {
    const state = term.historySearch;
    if (!state || !Number.isInteger(state.selectedHistoryIndex)) return false;
    const selected = term.history[state.selectedHistoryIndex];
    term.historySearch = null;
    term.historyCursor = -1;
    term.historyDraft = null;
    term.renderInput(selected, selected.length);
    return true;
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
    const reverseSearchKey =
      event.type === "keydown" &&
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "r";

    if (reverseSearchKey && normalInputAvailable()) {
      event.preventDefault();
      resetCompletion();
      repeatHistorySearch();
      term.scrollToBottom();
      return false;
    }

    if (term.historySearch) {
      if (event.key === "Tab") event.preventDefault();
      return event.key !== "Tab";
    }

    if (event.key === "Tab") {
      event.preventDefault();
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

  term.onData((e) => {
    if (normalInputAvailable()) {
      if (term.historySearch) {
        resetCompletion();
        switch (e) {
          case "\u0012": // Ctrl+R fallback for terminals bypassing key events
            repeatHistorySearch();
            break;
          case "\r": // Enter accepts a match but never executes it.
            if (!acceptHistorySearch()) term.renderHistorySearch(term.historySearch);
            break;
          case "\u001b": // Escape
          case "\u0007": // Ctrl+G
            cancelHistorySearch();
            break;
          case "\u0008": // Ctrl+H
          case "\u007F": // Backspace
            if (term.historySearch.query.length > 0) {
              updateHistorySearchQuery(term.historySearch.query.slice(0, -1));
            }
            break;
          default:
            if (e.length === 1 && e.charCodeAt(0) >= 32) {
              updateHistorySearchQuery(term.historySearch.query + e);
            }
            break;
        }
        term.scrollToBottom();
        return;
      }

      if (e !== "\t") resetCompletion();
      switch (e) {
        case "\r": // Enter
          // Reset tab and recall draft state before an actual submission.
          term.tabIndex = 0;
          term.tabOptions = [];
          term.tabBase = "";
          term.historyCursor = -1;
          term.historyDraft = null;
          term.executeCommandLine(term.currentLine);
          break;
        case "\u0001": // Ctrl+A
          updateInput(term.currentLine, 0);
          break;
        case "\u0005": // Ctrl+E
          updateInput(term.currentLine, term.currentLine.length);
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
          if (term.historyCursor === -1 && h.length > 0) {
            term.historyDraft = {
              line: term.currentLine,
              cursor: term.pos(),
            };
          }
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
            updateInput(h[term.historyCursor], h[term.historyCursor].length);
          } else if (term.historyCursor === 0) {
            const draft = term.historyDraft || { line: "", cursor: 0 };
            term.historyCursor = -1;
            term.historyDraft = null;
            updateInput(draft.line, draft.cursor);
          }
          break;
        case "\033[C": // right
          if (term.pos() < term.currentLine.length) {
            updateInput(term.currentLine, term.pos() + 1);
          }
          break;
        case "\033[D": // left
          if (term.pos() > 0) {
            updateInput(term.currentLine, term.pos() - 1);
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
            updateInput(
              term.currentLine.slice(0, pos) + e + term.currentLine.slice(pos),
              pos + 1
            );
          }
          break;
      }
      term.scrollToBottom();
    }
  });
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

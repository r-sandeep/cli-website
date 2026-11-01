// terminal-ext.js — Extends an xterm.js Terminal instance with all the custom
// behavior needed to run the Root Ventures CLI.
//
// Usage: call extend(term) once after creating the Terminal, before calling
// runRootTerminal(). This monkey-patches the term object in place rather than
// subclassing, which keeps it compatible with xterm addons.
//
// TODO: make this a proper xterm addon

const _parseCommandLine = (line) => {
  const tokens = [];
  let token = "";
  let quote = null;
  let started = false;

  for (const character of String(line)) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else token += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }

  if (started) tokens.push(token);
  return tokens;
};

const extend = (term) => {

  // ── State ──────────────────────────────────────────────────────────────────

  term.VERSION = term.VERSION || 3;  // bumped to 4 by `upgrade`
  term.currentLine = "";             // text the user has typed so far
  term._inputCursor = 0;             // logical cursor within currentLine
  term._inputCursorLine = "";         // line for which the cursor is authoritative
  term.user = "guest";
  term.host = "rootpc";
  term.cwd = "~";
  term.sep = ":";
  term._promptChar = "$";
  term.history = [];
  // Kept separate from the public string history. Each slot records how that
  // particular submission finished so duplicate pager commands can replay
  // without rerunning their producer or reconsidering the fit boundary.
  term._historyOutcomes = [];
  term.historyCursor = -1;
  term.busy = false;

  // User aliases are closure-owned so command code can only change them through
  // the storage-first methods below. Entry arrays preserve prototype-shaped
  // names such as `constructor` and `__proto__` without object-key surprises.
  const aliasStorageKey = "rootvc.aliases";
  const aliasNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const compareAliasNames = (left, right) =>
    left < right ? -1 : left > right ? 1 : 0;
  let userAliases = new Map();

  try {
    const storedAliases = window.localStorage.getItem(aliasStorageKey);
    if (storedAliases !== null) {
      const entries = JSON.parse(storedAliases);
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === "string" &&
            aliasNamePattern.test(entry[0]) &&
            typeof entry[1] === "string"
          ) {
            userAliases.set(entry[0], entry[1]);
          }
        }
      }
    }
  } catch (error) {
    // Storage can be unavailable or contain malformed JSON. In either case the
    // terminal starts with a safe empty alias set rather than failing startup.
    userAliases = new Map();
  }

  const persistAliases = (nextAliases) => {
    const entries = Array.from(nextAliases.entries()).sort(([left], [right]) =>
      compareAliasNames(left, right)
    );
    window.localStorage.setItem(aliasStorageKey, JSON.stringify(entries));
  };

  term.getAliases = () =>
    Array.from(userAliases.entries()).sort(([left], [right]) =>
      compareAliasNames(left, right)
    );

  term.getAlias = (name) =>
    userAliases.has(name) ? userAliases.get(name) : undefined;

  term.defineAlias = (name, value) => {
    if (!aliasNamePattern.test(name) || typeof value !== "string") {
      return false;
    }

    const nextAliases = new Map(userAliases);
    nextAliases.set(name, value);
    persistAliases(nextAliases);
    userAliases = nextAliases;
    return true;
  };

  term.removeAlias = (name) => {
    if (!aliasNamePattern.test(name) || !userAliases.has(name)) {
      return false;
    }

    const nextAliases = new Map(userAliases);
    nextAliases.delete(name);
    persistAliases(nextAliases);
    userAliases = nextAliases;
    return true;
  };

  // Environment variables are private to this extended terminal. Persist only
  // complete, validated snapshots so failed browser storage writes cannot leave
  // memory and localStorage describing different states.
  const ENV_STORAGE_KEY = "rootvc.cli.environment.v1";
  const ENV_STORAGE_VERSION = 1;
  const ENV_LIMIT = 50;
  const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

  const parseEnvironmentPayload = (serialized) => {
    if (serialized === null) return new Map();

    const payload = JSON.parse(serialized);
    if (
      payload === null ||
      typeof payload !== "object" ||
      Object.getPrototypeOf(payload) !== Object.prototype ||
      Object.keys(payload).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(payload, "version") ||
      payload.version !== ENV_STORAGE_VERSION ||
      !Object.prototype.hasOwnProperty.call(payload, "variables") ||
      !Array.isArray(payload.variables) ||
      payload.variables.length > ENV_LIMIT
    ) {
      throw new Error("Invalid environment payload");
    }

    const hydrated = new Map();
    for (const entry of payload.variables) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        !ENV_NAME_PATTERN.test(entry[0]) ||
        typeof entry[1] !== "string" ||
        hydrated.has(entry[0])
      ) {
        throw new Error("Invalid environment entry");
      }
      hydrated.set(entry[0], entry[1]);
    }
    return hydrated;
  };

  const serializeEnvironment = (variables) =>
    JSON.stringify({
      version: ENV_STORAGE_VERSION,
      variables: [...variables.entries()].sort(([a], [b]) => a.localeCompare(b)),
    });

  let environmentVariables;
  try {
    environmentVariables = parseEnvironmentPayload(
      window.localStorage.getItem(ENV_STORAGE_KEY)
    );
  } catch (_error) {
    environmentVariables = new Map();
  }

  const environmentResult = (ok, code, message = "") => ({ ok, code, message });
  let environmentPersistenceEnabled = true;
  const persistEnvironmentCandidate = (candidate) => {
    if (!environmentPersistenceEnabled) {
      environmentVariables = candidate;
      return environmentResult(true, "updated");
    }

    try {
      const serialized = serializeEnvironment(candidate);
      window.localStorage.setItem(ENV_STORAGE_KEY, serialized);
    } catch (_error) {
      return environmentResult(
        false,
        "storage",
        "Environment variables could not be saved. Storage is unavailable."
      );
    }
    environmentVariables = candidate;
    return environmentResult(true, "updated");
  };

  term.environment = Object.freeze({
    isValidName(name) {
      return typeof name === "string" && ENV_NAME_PATTERN.test(name);
    },
    snapshot() {
      return new Map(environmentVariables);
    },
    entries() {
      return [...environmentVariables.entries()].sort(([a], [b]) =>
        a.localeCompare(b)
      );
    },
    get(name) {
      return environmentVariables.get(name);
    },
    set(name, value) {
      if (
        typeof name !== "string" ||
        !ENV_NAME_PATTERN.test(name) ||
        typeof value !== "string"
      ) {
        return environmentResult(
          false,
          "invalid",
          "Invalid environment variable name. Use letters, digits, and underscores, starting with a letter or underscore."
        );
      }
      if (!environmentVariables.has(name) && environmentVariables.size >= ENV_LIMIT) {
        return environmentResult(
          false,
          "capacity",
          `Environment variable limit of ${ENV_LIMIT} reached.`
        );
      }

      const candidate = new Map(environmentVariables);
      candidate.set(name, value);
      return persistEnvironmentCandidate(candidate);
    },
    unset(name) {
      if (!environmentVariables.has(name)) {
        return environmentResult(true, "absent");
      }

      const candidate = new Map(environmentVariables);
      candidate.delete(name);
      return persistEnvironmentCandidate(candidate);
    },
  });

  // The replay may be asynchronous (resize replays each history line through
  // executeCommandLine so aliases and pipelines apply); the guard is held for
  // its whole duration and restored afterwards.
  const replayWithoutEnvironmentSideEffects = async (replay) => {
    const activeVariables = environmentVariables;
    const previousPersistenceSetting = environmentPersistenceEnabled;
    environmentVariables = new Map(activeVariables);
    environmentPersistenceEnabled = false;
    try {
      await replay();
    } finally {
      environmentVariables = activeVariables;
      environmentPersistenceEnabled = previousPersistenceSetting;
    }
  };

  // Tab completion state — reset on any non-tab keypress.
  term.tabIndex = 0;
  term.tabOptions = [];
  term.tabBase = "";

  // Cursor position relative to the start of the user's input (after the
  // prompt). Keep this independently of xterm's physical buffer column: once
  // input wraps, buffer.x is only the column on the final physical row.
  term.pos = () =>
    term._inputCursorLine === term.currentLine
      ? term._inputCursor
      : term._core.buffer.x - term._promptRawText().length - 1;

  // Plain-text prompt string used for length calculations.
  term._promptRawText = () =>
    `${term.user}${term.sep}${term.host} ${term.cwd} $`;

  // Deep link: parse the URL hash as a command to run on load.
  // E.g. /#whois-avidan → runs `whois avidan`.
  //
  // Only the FIRST hyphen separates the command from its argument. Splitting on
  // every hyphen would turn a hyphenated slug into two arguments, so a company
  // added to config/portfolio.js as `vibe-robotics` would break its own deep
  // link. No slug has a hyphen today, but fragments are now the only way to
  // address a specific company or person, so this has to hold for any slug.
  term.deepLink = (() => {
    const raw = window.location.hash.replace(/^#/, "");
    const split = raw.indexOf("-");
    if (split === -1) return raw;
    return `${raw.slice(0, split)} ${raw.slice(split + 1)}`;
  })();

  // ── Prompt ─────────────────────────────────────────────────────────────────

  // Returns the colorized prompt string for display.
  term.promptText = () => {
    var text = term
      ._promptRawText()
      .replace(term.user, colorText(term.user, "user"))
      .replace(term.sep, colorText(term.sep, ""))
      .replace(term.host, colorText(term.host, ""))
      .replace(term.cwd, colorText(term.cwd, "hyperlink"))
      .replace(term._promptChar, colorText(term._promptChar, "prompt"));
    return text;
  };

  // Writes a newline + prompt (default) or a custom prefix/suffix pair.
  term.prompt = (prefix = "\r\n", suffix = " ") => {
    term.write(`${prefix}${term.promptText()}${suffix}`);
  };

  // Erases the current input line and redraws the prompt, optionally resetting
  // the history cursor so the next Up arrow starts from the most recent entry.
  term.clearCurrentLine = (goToEndofHistory = false) => {
    // A recalled or completed command can wrap on narrow terminals. CSI 2K
    // clears only the physical row containing the cursor, leaving the earlier
    // wrapped rows behind to corrupt the next submitted line. Return to the
    // first physical prompt row and erase through the end of the input area.
    const columns = Math.max(1, Number.isFinite(term.cols) ? term.cols : 80);
    let logicalCursor = term.pos();
    if (!Number.isFinite(logicalCursor) || logicalCursor < 0) {
      logicalCursor = term.currentLine.length;
    }
    logicalCursor = Math.min(logicalCursor, term.currentLine.length);
    const occupiedColumns = term._promptRawText().length + 1 + logicalCursor;
    const cursorRow = Math.floor(Math.max(0, occupiedColumns - 1) / columns);
    term.write(`\r${"\x1b[A".repeat(cursorRow)}\x1b[J`);
    term.prompt("", " ");
    term.currentLine = "";
    term._inputCursor = 0;
    term._inputCursorLine = "";
    if (goToEndofHistory) {
      term.historyCursor = -1;
      term.scrollToBottom();
    }
  };

  // Replaces the current input with newLine, preserving cursor position if asked.
  term.setCurrentLine = (newLine, preserveCursor = false) => {
    // Capture position before clearCurrentLine() because the xterm buffer
    // cursor moves during the erase, making pos() unreliable immediately after.
    const oldPos = term.pos();
    const length = term.currentLine.length;
    term.clearCurrentLine();
    term.currentLine = newLine;
    term.write(newLine);
    if (preserveCursor) {
      term.write("\x1b[D".repeat(length - oldPos));
      term._inputCursor = Math.max(0, newLine.length - (length - oldPos));
    } else {
      term._inputCursor = newLine.length;
    }
    term._inputCursorLine = newLine;
  };

  // ── Output ─────────────────────────────────────────────────────────────────

  // Prints a line of text with three processing passes applied in order:
  //   1. URLs are detected and colorized as hyperlinks (disables wrapping for
  //      long URLs since wrapping mid-URL would break clickability).
  //   2. Long lines are word-wrapped to fit the terminal width (max 76 cols).
  //   3. %command% tokens are replaced with colorized command names.
  term.stylePrint = (text, wrap = true) => {
    const urlRegex =
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,24}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
    const urlMatches = text.matchAll(urlRegex);
    let allowWrapping = true;
    for (const match of urlMatches) {
      allowWrapping = match[0].length < 76; // don't wrap lines that contain long URLs
      text = text.replace(match[0], colorText(match[0], "hyperlink"));
    }

    if (allowWrapping && wrap) {
      text = _wordWrap(text, Math.min(term.cols, 76));
    }

    // Replace %commandName% tokens with styled command names.
    const cmds = Object.keys(commands);
    for (const cmd of cmds) {
      const cmdMatches = text.matchAll(`%${cmd}%`);
      for (const match of cmdMatches) {
        text = text.replace(match[0], colorText(cmd, "command"));
      }
    }

    term.writeln(text);
  };

  // Renders the preloaded ASCII art for id into the terminal.
  // Silently skipped on narrow terminals (< 40 cols).
  term.printArt = (id) => {
    if (term.cols >= 40) {
      const art = getArt(id);
      if (art) {
        term.writeln(`\r\n${art}\r\n`);
      } else {
        ensureASCIIArt(id);
      }
    }
  };

  // Prints the Root Ventures ASCII logotype, or a plain-text fallback on
  // very narrow terminals.
  term.printLogoType = () => {
    term.writeln(term.cols >= 40 ? LOGO_TYPE : "[Root Ventures]\r\n");
  };

  // Opens a URL in a new tab (default) or navigates the current page.
  term.openURL = (url, newWindow = true) => {
    term.stylePrint(`Opening ${url}`);
    if (term._initialized) {
      if (newWindow) {
        window.open(url, "_blank");
      } else {
        window.location.href = url;
      }
    }
  };

  // Prints a URL as a styled hyperlink without opening it.
  term.displayURL = (url) => {
    term.stylePrint(colorText(url, "hyperlink"));
  };

  // ── Animation Helpers ──────────────────────────────────────────────────────

  term.timer = (ms) => new Promise((res) => setTimeout(res, ms));

  // Prints phrase followed by n dots at 1-second intervals.
  term.dottedPrint = async (phrase, n, newline = true) => {
    term.write(phrase);

    for (let i = 0; i < n; i++) {
      await term.delayPrint(".", 1000);
    }
    if (newline) {
      term.write("\r\n");
    }
  };

  // Renders an animated progress bar that fills over time t (ms).
  // Randomizes the fill speed to look more authentic.
  term.progressBar = async (t, msg) => {
    var r;

    if (msg) {
      term.write(msg);
    }
    term.write("\r\n[");

    for (let i = 0; i < term.cols / 2; i = i + 1) {
      r = Math.round((Math.random() * t) / 20);
      t = t - r;
      await term.delayPrint("█", r);
    }
    term.write("]\r\n");
  };

  term.delayPrint = async (str, t) => {
    await term.timer(t);
    term.write(str);
  };

  term.delayStylePrint = async (str, t, wrap) => {
    await term.timer(t);
    term.stylePrint(str, wrap);
  };

  // ── Command Dispatch ───────────────────────────────────────────────────────

  const parseCommandLine = (line) => {
    const trimmedLine = String(line).trim();
    const [name = "", ...args] = _parseCommandLine(trimmedLine);
    const argumentStart = trimmedLine.search(/\s/);
    const parsed = {
      line: trimmedLine,
      name,
      cmd: name.toLowerCase(),
      args,
    };
    // Keep lexical syntax available to handlers without changing the parsed
    // command's longstanding enumerable shape used by preload and dispatch.
    Object.defineProperty(parsed, "rawArgs", {
      value: argumentStart === -1 ? "" : trimmedLine.slice(argumentStart).trimStart(),
    });
    return parsed;
  };

  // Dispatches an already prepared command. Redirecting commands use this seam
  // so expanded values remain opaque data rather than being parsed or expanded
  // for a second time. The alias handler additionally receives the parsed
  // record so the lexical rawArgs span reaches it.
  term.dispatchCommand = (cmd, args, parsed) => {
    const fn = commands[cmd];
    if (typeof fn === "undefined") {
      term.stylePrint(`Command not found: ${cmd}. Try 'help' to get started.`);
    } else if (cmd === "alias") {
      return fn(args, parsed);
    } else {
      return fn(args);
    }
  };

  const expandArgument = (argument, variables) => {
    let expanded = "";
    let index = 0;

    const referenceAt = (start) => {
      if (argument[start] !== "$") return null;
      if (argument[start + 1] === "{") {
        const close = argument.indexOf("}", start + 2);
        if (close === -1) return null;
        const name = argument.slice(start + 2, close);
        return ENV_NAME_PATTERN.test(name) ? { end: close + 1, name } : null;
      }

      const match = argument.slice(start + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      return match ? { end: start + 1 + match[0].length, name: match[0] } : null;
    };

    while (index < argument.length) {
      const escapedReference =
        argument[index] === "\\" ? referenceAt(index + 1) : null;
      if (escapedReference) {
        expanded += argument.slice(index + 1, escapedReference.end);
        index = escapedReference.end;
        continue;
      }

      const reference = referenceAt(index);
      if (reference) {
        expanded += variables.get(reference.name) ?? "";
        index = reference.end;
        continue;
      }

      expanded += argument[index];
      index += 1;
    }

    return expanded;
  };

  // Public quote-aware parse of a raw line (no alias or variable expansion).
  term.parseCommandLine = parseCommandLine;

  const expandUserAlias = (parsed) => {
    const value = term.getAlias(parsed.name);
    if (typeof value === "undefined") {
      return parsed;
    }

    // Shell-style first-word replacement: the stored value substitutes for the
    // command word and the caller's raw argument text follows verbatim. One
    // lexical parse of the result keeps line, cooked arguments, and the
    // non-enumerable rawArgs consumed by the alias handler coherent, while the
    // caller's own quoting, empty quoted words, and pipeline separators keep
    // exactly the meaning they had before expansion.
    const expandedLine =
      parsed.rawArgs.length > 0 ? `${value} ${parsed.rawArgs}` : value;
    return parseCommandLine(expandedLine);
  };

  // Expands environment variables in a parsed record's arguments exactly once.
  // The lexical rawArgs span is carried verbatim: an alias value keeps `$NAME`
  // for expansion at use time rather than at definition time.
  const prepareParsed = (parsed) => {
    const variables = term.environment.snapshot();
    const name = typeof parsed.name === "string" ? parsed.name : parsed.cmd;
    const prepared = {
      line: parsed.line,
      name,
      cmd: String(parsed.cmd).toLowerCase(),
      args: parsed.args.map((argument) => expandArgument(argument, variables)),
    };
    Object.defineProperty(prepared, "rawArgs", {
      value: typeof parsed.rawArgs === "string" ? parsed.rawArgs : "",
    });
    return prepared;
  };

  term.prepareCommandLine = (line) => prepareParsed(parseCommandLine(line));

  // Parses a raw line (or accepts a parsed record for an internal redirect),
  // expands environment variables once, and dispatches. User aliases are never
  // applied here: expansion belongs only to executeCommandLine below so a
  // redirect or replay cannot trigger a second alias lookup.
  term.command = (line) => {
    const parsed = typeof line === "string" ? parseCommandLine(line) : line;
    const prepared = prepareParsed(parsed);
    return term.dispatchCommand(prepared.cmd, prepared.args, prepared);
  };

  term.normalizeCommandForPreload = (cmd, args) => {
    switch (cmd) {
      case "man":
      case "woman":
        return { cmd: "tldr", args };
      case "tail":
      case "less":
      case "head":
      case "more":
        return { cmd: "cat", args };
      case "open":
        if (!args.length) {
          return { cmd, args };
        }

        if (
          (args[0].split(".")[0] == "test" && args[0].split(".")[1] == "htm") ||
          args[0].split(".")[1] == "htm" ||
          args.join(" ") == "the pod bay doors"
        ) {
          return { cmd, args };
        }

        return { cmd: "cat", args };
      default:
        return { cmd, args };
    }
  };

  // Accepts a prepared (cmd, args) pair, a raw line, or a parsed record.
  term.preloadCommandAssets = async (cmdOrLine, preparedArgs) => {
    const prepared = Array.isArray(preparedArgs)
      ? { cmd: cmdOrLine, args: preparedArgs }
      : typeof cmdOrLine === "string"
        ? term.prepareCommandLine(cmdOrLine)
        : prepareParsed(cmdOrLine);
    const normalized = term.normalizeCommandForPreload(prepared.cmd, prepared.args);
    const tasks = [];
    const artId = getASCIIArtIdForCommand(normalized.cmd, normalized.args);
    const preloadFile = getPreloadFileForCommand(normalized.cmd, normalized.args);

    if (artId) {
      tasks.push(ensureASCIIArt(artId));
    }

    if (preloadFile) {
      tasks.push(ensureFileLoaded(preloadFile));
    }

    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  };

  // Render fitted output through its original writer, or own xterm's alternate
  // screen until the pager closes. The normal buffer is never rewritten.
  term.pageOutput = async (renderedRecords, fittedWriter) => {
    const records = Array.from(renderedRecords || [], (record) =>
      record == null ? "" : String(record)
    );
    const pager = await Pager.create(records, {
      cols: term.cols,
      rows: term.rows,
    });
    const execution = term._pagerExecution;
    const saveOutcome = (outcome) => {
      if (!execution) return;
      execution.pagerOutcome = outcome;
      if (execution.historyIndex >= 0) {
        term._historyOutcomes[execution.historyIndex] = outcome;
      }
    };

    // Deep links are intentionally noninteractive. They use the same original
    // writer as a fitted command even when their output would fill the screen.
    if (!pager.shouldPage || execution?.pagerMode === "noninteractive") {
      const outcome = { paged: false, records };
      saveOutcome(outcome);
      if (typeof fittedWriter === "function") await fittedWriter();
      return outcome;
    }

    const pagedOutcome = { paged: true, records: [] };
    saveOutcome(pagedOutcome);
    return new Promise((resolve, reject) => {
      const session = {
        pager,
        closing: false,
        resized: false,
        renderQueue: Promise.resolve(),
      };
      term._pagerSession = session;

      const finish = () => {
        if (term._pagerSession === session) term._pagerSession = null;
        resolve(pagedOutcome);
      };
      const fail = (error) => {
        if (term._pagerSession === session) term._pagerSession = null;
        reject(error);
      };

      session.renderQueue = _writeTerminal(term, "\x1b[?1049h")
        .then(() => pager.render(term))
        .catch(fail);
      session.resize = () => {
        if (session.closing) return session.renderQueue;
        const anchorSourceLine = pager.topSourceLine;
        session.resized = true;
        session.renderQueue = session.renderQueue
          .then(() => pager.relayout(
            { cols: term.cols, rows: term.rows },
            anchorSourceLine
          ))
          .then(() => pager.render(term));
        return session.renderQueue;
      };
      session.handleKey = (key) => {
        if (session.closing) return true;
        const result = pager.handleKey(key);
        if (result.action === "close") {
          session.closing = true;
          session.renderQueue = session.renderQueue
            .then(() => _writeTerminal(term, "\x1b[?1049l"))
            // Resizing xterm also resizes its hidden normal buffer. Rebuild that
            // buffer through the ordinary replay path, but let this still-open
            // command emit the one completion prompt after the pager resolves.
            .then(() => session.resized
              ? term._redrawNormalBuffer({ promptAfter: false })
              : undefined)
            .then(finish, fail);
        } else {
          session.renderQueue = session.renderQueue.then(() => pager.render(term), fail);
        }
        return true;
      };
    });
  };

  term.handlePagerKey = (key) => {
    const session = term._pagerSession;
    if (!session || typeof session.handleKey !== "function") return false;
    session.handleKey(key);
    return true;
  };

  term.executeCommandLine = async (line, options = {}) => {
    const submittedLine = String(line);
    const settings = {
      addToHistory: true,
      manageBusy: true,
      promptAfter: true,
      showLeadingNewline: true,
      trackAnalytics: true,
      scrollAfter: true,
      pagerMode: "interactive",
      replayOutcome: undefined,
      ...options,
    };
    const pagerExecution = {
      historyIndex: -1,
      pagerMode: settings.pagerMode,
      pagerOutcome: null,
    };
    term._pagerExecution = pagerExecution;
    const addHistory = (historyLine) => {
      term.history.push(historyLine);
      term._historyOutcomes.push(null);
      pagerExecution.historyIndex = term.history.length - 1;
    };
    const parsed = parseCommandLine(submittedLine);
    // User aliases expand exactly once, on the interactive line and before
    // pipeline parsing; redirects and replays never expand a second time.
    const expanded = expandUserAlias(parsed);
    const parsedPipeline = Pipeline.parsePipeline(expanded.line);
    let exitStatus;

    try {
      // A pager submission has an occurrence-specific completed result. During
      // resize replay, reproduce that result directly rather than rerunning its
      // producer or asking whether it fits at the new dimensions.
      if (settings.replayOutcome) {
        if (!settings.replayOutcome.paged) {
          for (const record of settings.replayOutcome.records || []) {
            term.writeln(record);
          }
        }
        return exitStatus;
      }
      if (settings.manageBusy) {
        term.busy = true;
      }

      if (parsedPipeline) {
        const validation = Pipeline.validatePipeline(parsedPipeline);

        if (!validation.ok) {
          if (settings.showLeadingNewline && parsed.cmd != "upgrade") {
            term.writeln("");
          }

          if (parsed.line.length > 0 && settings.addToHistory) {
            addHistory(submittedLine);
          }

          term.stylePrint(validation.error.message);

          if (settings.trackAnalytics) {
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({
              event: "commandSent",
              command: parsed.cmd,
              args: parsed.args.join(" "),
            });
          }
        } else {
          await term.preloadCommandAssets(validation.producer);

          if (settings.showLeadingNewline && parsed.cmd != "upgrade") {
            term.writeln("");
          }

          if (settings.addToHistory) {
            addHistory(submittedLine);
          }

          const capture = _captureTerminalOutput(term);
          try {
            exitStatus = await term.command(validation.producer);
          } finally {
            capture.restore();
          }

          const result = Pipeline.applyPipeline(capture.lines(), validation.filters, {
            getText: _visibleTerminalText,
            prefixLine: (outputLine, lineNumber) => `${lineNumber}:${outputLine}`,
            prefixCount: (outputLine, count) => `${count} ${outputLine}`,
          });

          if (result.error) {
            term.stylePrint(result.error.message);
          } else if (validation.pager) {
            await term.pageOutput(result.lines, () => {
              for (const outputLine of result.lines) term.writeln(outputLine);
            });
          } else {
            for (const outputLine of result.lines) {
              term.writeln(outputLine);
            }
          }

          // Interactive producers own their normal prompt cleanup. Defer that
          // cleanup until their captured continuation and all filters settle.
          capture.flushPromptCleanup();

          if (settings.trackAnalytics) {
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({
              event: "commandSent",
              command: parsed.cmd,
              args: parsed.args.join(" "),
            });
          }
        }
      } else {
        // Interactive execution prepares (expands) the alias-expanded line
        // exactly once, before preload, and dispatches the prepared record so
        // expanded values stay opaque data instead of being parsed or expanded
        // a second time, and so the lexical rawArgs reach the alias handler.
        const prepared = prepareParsed(expanded);
        await term.preloadCommandAssets(prepared.cmd, prepared.args);

        if (settings.showLeadingNewline && parsed.cmd != "upgrade") {
          term.writeln("");
        }

        if (parsed.line.length > 0) {
          if (settings.addToHistory) {
            addHistory(submittedLine);
          }

          // Commands may own an interactive continuation. Await its final
          // status so standalone prompt cleanup observes the same lifecycle as
          // a piped producer.
          exitStatus = await term.dispatchCommand(prepared.cmd, prepared.args, prepared);

          if (settings.trackAnalytics) {
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({
              event: "commandSent",
              command: parsed.cmd,
              args: parsed.args.join(" "),
            });
          }
        }
      }
    } catch (error) {
      console.error("Command preparation failed", error);
      term.stylePrint("Command failed to load required assets. Please try again.");
    } finally {
      if (settings.promptAfter && exitStatus != 1 && parsed.cmd != "upgrade") {
        term.prompt();
        term.clearCurrentLine(true);
      }

      if (settings.manageBusy) {
        term.busy = false;
      }

      if (term._pagerExecution === pagerExecution) {
        term._pagerExecution = null;
      }

      if (settings.scrollAfter) {
        term.scrollToBottom();
      }
    }

    return exitStatus;
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  term._redrawNormalBuffer = async ({ promptAfter = true } = {}) => {
    term._initialized = false;
    term.init(term.user, true);
    if (typeof preloadASCIIArt === "function") {
      window.scheduleIdleTask(() => preloadASCIIArt(), 1500);
    }
    await term.runDeepLink({ replay: true });
    // Replay serially through the full execution boundary. Pager submissions
    // consume their aligned completed outcome; ordinary history retains the
    // existing environment-side-effect sandbox.
    await replayWithoutEnvironmentSideEffects(async () => {
      for (let index = 0; index < term.history.length; index++) {
        const c = term.history[index];
        term.prompt("\r\n", ` ${c}\r\n`);
        if (expandUserAlias(parseCommandLine(c)).cmd !== "tui") {
          await term.executeCommandLine(c, {
            addToHistory: false,
            manageBusy: false,
            promptAfter: false,
            showLeadingNewline: false,
            trackAnalytics: false,
            scrollAfter: false,
            pagerMode: "noninteractive",
            replayOutcome: term._historyOutcomes[index] || undefined,
          });
        }
      }
    });
    if (promptAfter) term.prompt();
    term.scrollToBottom();
    term._initialized = true;
  };

  // Called on window resize. A modal owns the alternate screen, so reflow it
  // in place. Otherwise rebuild xterm's normal buffer through the established
  // init/deep-link/history redraw path.
  term.resizeListener = async () => {
    if (window.rootTui?.active) {
      window.fitAddon.fit();
      return;
    }
    if (term._pagerSession) {
      window.fitAddon.fit();
      return term._pagerSession.resize();
    }
    return term._redrawNormalBuffer();
  };

  // Resets the terminal to its initial state. If VERSION < 4, shows an upgrade
  // prompt instead of the welcome message. Announces open jobs if any exist.
  term.init = (user = "guest", preserveHistory = false) => {
    window.fitAddon.fit();
    term.reset();
    term.printLogoType();
    if (term.VERSION == 3) {
      term.stylePrint(
        `\n${colorText("New version of Root Ventures detected.", "user")}`
      );
      term.stylePrint(
        `Please upgrade your terminal with ${colorText("upgrade", "command")}.`
      );
    } else {
      term.stylePrint(
        "Welcome to the Root Ventures terminal. Seeding bold engineers!"
      );
      term.stylePrint(
        `Type ${colorText(
          "help",
          "command"
        )} to get started. Or type ${colorText(
          "exit",
          "command"
        )} for web version.`,
        false
      );
    }
    if (Object.keys(jobs).length > 0) {
      term.stylePrint(
        `\r\nOpen jobs detected. Type ${colorText(
          "jobs",
          "command"
        )} for more info.`,
        false
      );
    }

    term.user = user;
    if (!preserveHistory) {
      term.history = [];
      term._historyOutcomes = [];
    } else {
      // Older callers may replace history directly. Preserve occurrence order
      // while ensuring every string has an aligned outcome slot.
      term._historyOutcomes.length = term.history.length;
    }
    term.focus();
  };

  // Runs the deep-link command parsed from the URL hash on page load.
  //
  // `replay` is set by the resize listener, which reruns this to redraw a
  // buffer xterm cleared. That is the same visit, not a new arrival, so it must
  // not be counted again. History replay uses the same execution boundary with
  // its user-visible submission side effects disabled for the same reason.
  term.runDeepLink = ({ replay = false } = {}) => {
    if (replay && expandUserAlias(parseCommandLine(term.deepLink)).cmd === "tui") return;
    if (term.deepLink != "") {
      return term.executeCommandLine(term.deepLink, {
        addToHistory: false,
        promptAfter: false,
        showLeadingNewline: false,
        // Deep links are how visitors now reach a specific company or person,
        // so these are the arrivals worth counting. Fragments never fire a
        // pageview of their own, so without this they would be invisible.
        trackAnalytics: !replay,
        pagerMode: "noninteractive",
      }).catch((error) => {
        console.error("Deep link failed", error);
      });
    }

    return Promise.resolve();
  };

  // ── Interactive Input ──────────────────────────────────────────────────────

  // Prompts the user for a single line of input, suspending the normal input
  // handler while waiting. Returns a Promise that resolves to:
  //   - A trimmed string if the user pressed Enter (may be "" for optional fields)
  //   - null if the user pressed Ctrl+C (cancelled)
  term.collectInput = (prompt, isOptional = false) => {
    return new Promise((resolve) => {
      term.locked = true;
      term.write(`\r\n${prompt}${isOptional ? ' (optional)' : ''}: `);
      let inputBuffer = '';

      const inputHandler = term.onData((e) => {
        switch (e) {
          case '\r': // Enter — submit
            term.write('\r\n');
            inputHandler.dispose();
            term.locked = false;
            resolve(inputBuffer.trim());
            break;
          case '\u0003': // Ctrl+C — cancel, resolves to null
            term.write('^C\r\n');
            inputHandler.dispose();
            term.locked = false;
            resolve(null);
            break;
          case '\u007F': // Backspace
          case '\u0008': // Ctrl+H
            if (inputBuffer.length > 0) {
              inputBuffer = inputBuffer.slice(0, -1);
              term.write('\b \b'); // erase character from display
            }
            break;
          case '\u0015': // Ctrl+U — clear entire input line
            while (inputBuffer.length > 0) {
              term.write('\b \b');
              inputBuffer = inputBuffer.slice(0, -1);
            }
            break;
          case '\033[A': // Up arrow
          case '\033[B': // Down arrow
          case '\033[C': // Right arrow
          case '\033[D': // Left arrow
            // Ignore — cursor movement not supported in collectInput
            break;
          default:
            // Only accept printable ASCII characters
            if (e.length === 1 && e.charCodeAt(0) >= 32 && e.charCodeAt(0) < 127) {
              inputBuffer += e;
              term.write(e);
            }
            break;
        }
      });
    });
  };
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function _writeTerminal(term, text) {
  return new Promise((resolve) => term.write(text, resolve));
}

// Captures the rendered stream emitted by one producer command. Writers are
// restored by the caller in a finally block before filtering or prompting.
function _captureTerminalOutput(term) {
  const originalWrite = term.write;
  const originalWriteln = term.writeln;
  const originalCollectInput = term.collectInput;
  const originalPrompt = term.prompt;
  const originalClearCurrentLine = term.clearCurrentLine;
  let active = true;
  let output = "";
  let promptRequested = false;
  let clearCurrentLineArgs = null;

  const captureWrite = (text, callback) => {
    output += text == null ? "" : String(text);
    if (typeof callback === "function") callback();
  };
  const captureWriteln = (text, callback) => {
    output += (text == null ? "" : String(text)) + "\r\n";
    if (typeof callback === "function") callback();
  };

  term.write = captureWrite;
  term.writeln = captureWriteln;
  term.prompt = () => {
    promptRequested = true;
  };
  term.clearCurrentLine = (...args) => {
    clearCurrentLineArgs = args;
  };

  // Interactive input control text and user echo are terminal UI, not producer
  // records. Display them normally, then resume capture when input completes.
  if (typeof originalCollectInput === "function") {
    term.collectInput = async (...args) => {
      term.write = originalWrite;
      term.writeln = originalWriteln;
      try {
        return await originalCollectInput.apply(term, args);
      } finally {
        // The producer may start an interactive flow without returning its
        // promise. Do not let that displaced work reinstate capture after the
        // pipeline has already restored terminal ownership.
        if (active) {
          term.write = captureWrite;
          term.writeln = captureWriteln;
        }
      }
    };
  }

  return {
    lines: () => {
      if (output.length === 0) return [];
      const lines = output.split(/\r\n|\n|\r/);
      if (lines[lines.length - 1] === "") lines.pop();
      return lines;
    },
    restore: () => {
      active = false;
      term.write = originalWrite;
      term.writeln = originalWriteln;
      term.prompt = originalPrompt;
      term.clearCurrentLine = originalClearCurrentLine;
      if (typeof originalCollectInput === "function") {
        term.collectInput = originalCollectInput;
      }
    },
    flushPromptCleanup: () => {
      if (clearCurrentLineArgs) {
        originalClearCurrentLine.apply(term, clearCurrentLineArgs);
      } else if (promptRequested) {
        originalPrompt.call(term);
      }
    },
  };
}

// ANSI styling is retained in output records but ignored by matching/counting.
function _visibleTerminalText(text) {
  return String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|[@-_])/g, "");
}

// Wraps str at word boundaries to fit within maxWidth characters per line.
// Falls back to a hard break at maxWidth if no whitespace is found.
// TODO: This doesn't work well at detecting existing newlines in the input.
// https://stackoverflow.com/questions/14484787/wrap-text-in-javascript
function _wordWrap(str, maxWidth) {
  const newLineStr = "\r\n";
  let res = "";
  while (str.length > maxWidth) {
    let found = false;
    // Scan backwards from maxWidth to find a whitespace break point.
    for (let i = maxWidth - 1; i >= 0; i--) {
      if (_testWhite(str.charAt(i))) {
        res = res + [str.slice(0, i), newLineStr].join("");
        str = str.slice(i + 1);
        found = true;
        break;
      }
    }
    // No whitespace found — hard-break at maxWidth.
    if (!found) {
      res += [str.slice(0, maxWidth), newLineStr].join("");
      str = str.slice(maxWidth);
    }
  }
  return res + str;
}

function _testWhite(x) {
  const white = /^\s$/;
  return white.test(x.charAt(0));
}

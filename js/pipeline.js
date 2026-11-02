// Pure parsing, validation, and line transforms for terminal output pipelines.
// This stays side-effect free so terminal dispatch can decide when to run the
// producer and how to render the resulting lines.
var Pipeline = (function () {
  function parseStage(source) {
    var tokens = source ? source.split(/\s+/) : [];
    return {
      source: source,
      name: tokens[0] || "",
      args: tokens.slice(1),
    };
  }

  function splitPipeline(commandLine) {
    var parts = [];
    var start = 0;
    var quote = "";

    for (var index = 0; index < commandLine.length; index += 1) {
      var character = commandLine.charAt(index);
      if (character === "'" || character === '"') {
        if (!quote) quote = character;
        else if (quote === character) quote = "";
      } else if (character === "|" && !quote) {
        parts.push(commandLine.slice(start, index).trim());
        start = index + 1;
      }
    }
    parts.push(commandLine.slice(start).trim());
    return parts;
  }

  function parsePipeline(commandLine) {
    if (typeof commandLine !== "string" || commandLine.indexOf("|") === -1) {
      return null;
    }

    var parts = splitPipeline(commandLine);
    if (parts.length === 1) return null;

    return {
      producer: parts[0],
      stages: parts.slice(1).map(parseStage),
    };
  }

  function preDispatchError(stageName, message) {
    return {
      ok: false,
      error: {
        type: "pre-dispatch",
        stageName: stageName,
        message: message,
      },
    };
  }

  function compileGrep(stage) {
    var ignoreCase = false;
    var invert = false;
    var number = false;
    var args = stage.args.slice();
    var index = 0;

    while (index < args.length) {
      var arg = args[index];
      if (arg === "--") {
        index += 1;
        break;
      }
      if (arg.charAt(0) !== "-") break;
      if (!/^-([ivn]+)$/.test(arg)) {
        return preDispatchError(
          stage.name,
          "grep: supported flags are -i, -v, and -n"
        );
      }

      for (var flagIndex = 1; flagIndex < arg.length; flagIndex += 1) {
        if (arg.charAt(flagIndex) === "i") ignoreCase = true;
        if (arg.charAt(flagIndex) === "v") invert = true;
        if (arg.charAt(flagIndex) === "n") number = true;
      }
      index += 1;
    }

    var pattern = args.slice(index).join(" ");
    if (!pattern) {
      return preDispatchError(stage.name, "grep: a pattern is required");
    }

    return {
      ok: true,
      filter: {
        type: "grep",
        name: stage.name,
        pattern: pattern,
        ignoreCase: ignoreCase,
        invert: invert,
        number: number,
      },
    };
  }

  function compileCountFilter(stage) {
    if (stage.args.length > 1) {
      return preDispatchError(
        stage.name,
        stage.name + ": count must be a positive base-10 integer"
      );
    }

    var count = 10;
    if (stage.args.length === 1) {
      var value = stage.args[0];
      count = Number(value);
      if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(count) || count <= 0) {
        return preDispatchError(
          stage.name,
          stage.name + ": count must be a positive base-10 integer"
        );
      }
    }

    return {
      ok: true,
      filter: {
        type: stage.name,
        name: stage.name,
        count: count,
      },
    };
  }

  function compileFlagFilter(stage, supportedFlags) {
    var flags = {};
    for (var index = 0; index < stage.args.length; index += 1) {
      var arg = stage.args[index];
      var matcher = new RegExp("^-([" + supportedFlags + "]+)$");
      if (!matcher.test(arg)) {
        return preDispatchError(
          stage.name,
          stage.name + ": supported flags are " + supportedFlags.split("").map(function (flag) {
            return "-" + flag;
          }).join(", ")
        );
      }
      for (var flagIndex = 1; flagIndex < arg.length; flagIndex += 1) {
        flags[arg.charAt(flagIndex)] = true;
      }
    }

    return {
      ok: true,
      filter: {
        type: stage.name,
        name: stage.name,
        flags: flags,
      },
    };
  }

  function tokenizeCutStage(source) {
    var tokens = [];
    var token = "";
    var quote = "";
    var tokenStarted = false;

    for (var index = 0; index < source.length; index += 1) {
      var character = source.charAt(index);
      if (quote) {
        if (character === quote) quote = "";
        else token += character;
        tokenStarted = true;
      } else if (character === "'" || character === '"') {
        quote = character;
        tokenStarted = true;
      } else if (/\s/.test(character)) {
        if (tokenStarted) {
          tokens.push(token);
          token = "";
          tokenStarted = false;
        }
      } else {
        token += character;
        tokenStarted = true;
      }
    }
    if (tokenStarted) tokens.push(token);
    return tokens;
  }

  function normalizeDecimal(value) {
    return value.replace(/^0+(?=\d)/, "");
  }

  function compareDecimals(left, right) {
    left = normalizeDecimal(left);
    right = normalizeDecimal(right);
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function parseCutList(value, stageName) {
    if (value === "") {
      return preDispatchError(stageName, "cut: LIST cannot be empty");
    }

    var items = value.split(",");
    var intervals = [];
    for (var index = 0; index < items.length; index += 1) {
      var item = items[index];
      if (!item) {
        return preDispatchError(stageName, "cut: LIST items cannot be empty");
      }

      var start;
      var end;
      if (/^\d+$/.test(item)) {
        start = item;
        end = item;
      } else {
        var range = item.match(/^(\d*)-(\d*)$/);
        if (!range || (!range[1] && !range[2])) {
          return preDispatchError(stageName, "cut: invalid LIST item " + item);
        }
        start = range[1] || "1";
        end = range[2] || null;
      }

      if (compareDecimals(start, "0") === 0 || (end !== null && compareDecimals(end, "0") === 0)) {
        return preDispatchError(stageName, "cut: positions must be positive");
      }
      start = normalizeDecimal(start);
      if (end !== null) end = normalizeDecimal(end);
      if (end !== null && compareDecimals(start, end) > 0) {
        return preDispatchError(stageName, "cut: range start must not exceed end");
      }
      intervals.push({ start: start, end: end });
    }

    return { ok: true, intervals: intervals };
  }

  function compileCut(stage) {
    var tokens = tokenizeCutStage(stage.source).slice(1);
    var mode = null;
    var list = null;
    var delimiter = "\t";
    var delimiterSet = false;
    var suppress = false;

    for (var index = 0; index < tokens.length; index += 1) {
      var arg = tokens[index];
      if (arg === "-f" || arg === "-c") {
        var nextMode = arg === "-f" ? "fields" : "characters";
        if (mode) {
          return preDispatchError(
            stage.name,
            mode === nextMode
              ? "cut: " + arg + " may only be specified once"
              : "cut: -f and -c cannot be used together"
          );
        }
        if (index + 1 >= tokens.length) {
          return preDispatchError(stage.name, "cut: " + arg + " requires a LIST");
        }
        mode = nextMode;
        list = tokens[index + 1];
        index += 1;
      } else if (arg === "-d" || arg.indexOf("-d") === 0) {
        if (delimiterSet) {
          return preDispatchError(stage.name, "cut: -d may only be specified once");
        }
        delimiterSet = true;
        if (arg === "-d") {
          if (index + 1 >= tokens.length) {
            return preDispatchError(stage.name, "cut: -d requires a delimiter");
          }
          delimiter = tokens[index + 1];
          index += 1;
        } else {
          delimiter = arg.slice(2);
        }
        if (Array.from(delimiter).length !== 1) {
          return preDispatchError(stage.name, "cut: delimiter must be exactly one character");
        }
      } else if (arg === "-s") {
        if (suppress) {
          return preDispatchError(stage.name, "cut: -s may only be specified once");
        }
        suppress = true;
      } else {
        return preDispatchError(stage.name, "cut: unsupported option " + arg);
      }
    }

    if (!mode) {
      return preDispatchError(stage.name, "cut: exactly one of -f or -c is required");
    }
    if (mode === "characters" && delimiterSet) {
      return preDispatchError(stage.name, "cut: -d cannot be used with -c");
    }
    if (mode === "characters" && suppress) {
      return preDispatchError(stage.name, "cut: -s cannot be used with -c");
    }

    var parsedList = parseCutList(list, stage.name);
    if (!parsedList.ok) return parsedList;
    return {
      ok: true,
      filter: {
        type: "cut",
        name: stage.name,
        mode: mode,
        intervals: parsedList.intervals,
        delimiter: delimiter,
        suppress: suppress,
      },
    };
  }

  function cutPositionSelected(position, intervals) {
    var decimalPosition = String(position);
    for (var index = 0; index < intervals.length; index += 1) {
      var interval = intervals[index];
      if (compareDecimals(decimalPosition, interval.start) < 0) continue;
      if (interval.end === null || compareDecimals(decimalPosition, interval.end) <= 0) {
        return true;
      }
    }
    return false;
  }

  function compileStage(stage) {
    if (!stage.name) {
      return preDispatchError("", "Pipeline stages cannot be empty");
    }
    if (stage.name === "cut") return compileCut(stage);
    if (stage.name === "grep") return compileGrep(stage);
    if (stage.name === "head" || stage.name === "tail") {
      return compileCountFilter(stage);
    }
    if (stage.name === "sort") return compileFlagFilter(stage, "rnu");
    if (stage.name === "uniq") return compileFlagFilter(stage, "cd");
    if (stage.name === "wc") {
      if (stage.args.length !== 1 || stage.args[0] !== "-l") {
        return preDispatchError(stage.name, "wc: only wc -l is supported");
      }
      return {
        ok: true,
        filter: { type: "wc", name: stage.name },
      };
    }

    return {
      ok: true,
      filter: {
        type: "unknown",
        name: stage.name,
      },
    };
  }

  function validatePipeline(parsedPipeline) {
    if (!parsedPipeline || !parsedPipeline.producer) {
      return preDispatchError("", "A pipeline producer is required");
    }
    if (!parsedPipeline.stages || parsedPipeline.stages.length === 0) {
      return preDispatchError("", "At least one pipeline stage is required");
    }

    var filters = [];
    for (var index = 0; index < parsedPipeline.stages.length; index += 1) {
      var result = compileStage(parsedPipeline.stages[index]);
      if (!result.ok) return result;
      filters.push(result.filter);
    }

    return {
      ok: true,
      producer: parsedPipeline.producer,
      filters: filters,
    };
  }

  function applyPipelineFilter(inputLines, filter, options) {
    var lines = inputLines || [];
    var getText = options && options.getText
      ? options.getText
      : function (line) { return String(line); };
    var prefixLine = options && options.prefixLine
      ? options.prefixLine
      : function (line, lineNumber) { return lineNumber + ":" + line; };
    var prefixCount = options && options.prefixCount
      ? options.prefixCount
      : function (line, count) { return count + " " + line; };

    if (filter.type === "unknown") {
      return {
        lines: [],
        error: {
          type: "unknown-filter",
          stageName: filter.name,
          message: "Unknown pipeline filter: " + filter.name,
        },
      };
    }

    if (filter.type === "cut") {
      var cutLines = [];
      lines.forEach(function (line) {
        var text = String(getText(line));
        if (filter.mode === "fields" && text.indexOf(filter.delimiter) === -1) {
          if (!filter.suppress) cutLines.push(line);
          return;
        }

        var values = filter.mode === "fields" ? text.split(filter.delimiter) : Array.from(text);
        var selected = [];
        for (var position = 1; position <= values.length; position += 1) {
          if (cutPositionSelected(position, filter.intervals)) {
            selected.push(values[position - 1]);
          }
        }
        cutLines.push(selected.join(filter.mode === "fields" ? filter.delimiter : ""));
      });
      return { lines: cutLines, error: null };
    }

    if (filter.type === "head") {
      return { lines: lines.slice(0, filter.count), error: null };
    }
    if (filter.type === "tail") {
      return { lines: lines.slice(Math.max(0, lines.length - filter.count)), error: null };
    }
    if (filter.type === "wc") {
      return { lines: [String(lines.length)], error: null };
    }
    if (filter.type === "sort") {
      var decorated = lines.map(function (line, index) {
        var text = String(getText(line));
        var numericMatch = text.match(/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/);
        return {
          line: line,
          text: text,
          index: index,
          number: numericMatch ? Number(numericMatch[1]) : null,
        };
      });

      decorated.sort(function (left, right) {
        var comparison = 0;
        if (filter.flags.n) {
          if (left.number === null && right.number !== null) comparison = -1;
          else if (left.number !== null && right.number === null) comparison = 1;
          else if (left.number !== null && right.number !== null) {
            comparison = left.number < right.number ? -1 : left.number > right.number ? 1 : 0;
          }
        } else {
          comparison = left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
        }
        if (comparison !== 0 && filter.flags.r) comparison *= -1;
        return comparison || left.index - right.index;
      });

      if (filter.flags.u) {
        var seen = Object.create(null);
        decorated = decorated.filter(function (entry) {
          if (Object.prototype.hasOwnProperty.call(seen, entry.text)) return false;
          seen[entry.text] = true;
          return true;
        });
      }
      return {
        lines: decorated.map(function (entry) { return entry.line; }),
        error: null,
      };
    }
    if (filter.type === "uniq") {
      var groups = [];
      lines.forEach(function (line) {
        var text = String(getText(line));
        var group = groups[groups.length - 1];
        if (group && group.text === text) {
          group.count += 1;
        } else {
          groups.push({ line: line, text: text, count: 1 });
        }
      });
      return {
        lines: groups.filter(function (group) {
          return !filter.flags.d || group.count > 1;
        }).map(function (group) {
          return filter.flags.c ? prefixCount(group.line, group.count) : group.line;
        }),
        error: null,
      };
    }

    var pattern = filter.ignoreCase ? filter.pattern.toLowerCase() : filter.pattern;
    var output = [];
    lines.forEach(function (line, index) {
      var text = getText(line);
      if (filter.ignoreCase) text = text.toLowerCase();
      var matches = text.indexOf(pattern) !== -1;
      if (filter.invert) matches = !matches;
      if (!matches) return;
      output.push(filter.number ? prefixLine(line, index + 1) : line);
    });
    return { lines: output, error: null };
  }

  function applyPipeline(inputLines, filters, options) {
    var result = { lines: (inputLines || []).slice(), error: null };
    for (var index = 0; index < filters.length; index += 1) {
      result = applyPipelineFilter(result.lines, filters[index], options);
      if (result.error) return result;
    }
    return result;
  }

  return {
    applyPipeline: applyPipeline,
    applyPipelineFilter: applyPipelineFilter,
    parsePipeline: parsePipeline,
    validatePipeline: validatePipeline,
  };
})();

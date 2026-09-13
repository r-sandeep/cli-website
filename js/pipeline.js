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

  function parsePipeline(commandLine) {
    if (typeof commandLine !== "string" || commandLine.indexOf("|") === -1) {
      return null;
    }

    var parts = commandLine.split("|").map(function (part) {
      return part.trim();
    });

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

  function compileStage(stage) {
    if (!stage.name) {
      return preDispatchError("", "Pipeline stages cannot be empty");
    }
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

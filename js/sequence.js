// Parses sequence operators from the original typed line before aliases,
// pipelines, or environment variables can introduce operator-looking text.
// Keep this a classic script: build-assets.js concatenates it ahead of the
// terminal consumers.
var Sequence = (function () {
  function operatorAt(source, index) {
    if (source[index] === ";") return ";";
    if (source.slice(index, index + 2) === "&&") return "&&";
    if (source.slice(index, index + 2) === "||") return "||";
    return null;
  }

  function syntaxError(operator) {
    return {
      ok: false,
      error: {
        operator: operator,
        message: "sequence: unexpected " + operator,
      },
      segments: [],
      operators: [],
    };
  }

  function scan(line) {
    var source = String(line);
    var segments = [];
    var operators = [];
    var segmentStart = 0;
    var quote = null;
    var index = 0;

    while (index < source.length) {
      var character = source[index];
      if (quote !== null) {
        if (character === quote) quote = null;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        index += 1;
        continue;
      }

      var operator = operatorAt(source, index);
      if (operator === null) {
        index += 1;
        continue;
      }

      var segmentSource = source.slice(segmentStart, index);
      if (segmentSource.trim().length === 0) return syntaxError(operator);
      segments.push({
        source: segmentSource,
        start: segmentStart,
        end: index,
      });
      operators.push(operator);
      index += operator.length;
      segmentStart = index;
    }

    var finalSource = source.slice(segmentStart);
    if (finalSource.trim().length > 0) {
      segments.push({
        source: finalSource,
        start: segmentStart,
        end: source.length,
      });
    } else if (operators.length === 0) {
      segments.push({ source: finalSource, start: 0, end: source.length });
    } else if (operators[operators.length - 1] !== ";") {
      return syntaxError(operators[operators.length - 1]);
    }

    return {
      ok: true,
      error: null,
      segments: segments,
      operators: operators,
    };
  }

  // Returns the raw segment containing the logical cursor. This lets completion
  // reuse standalone behavior without rebuilding or trimming the typed prefix.
  function segmentAt(line, cursor) {
    var source = String(line);
    var end = cursor === undefined ? source.length : cursor;
    end = Math.max(0, Math.min(source.length, end));
    var start = 0;
    var quote = null;
    var index = 0;

    while (index < end) {
      var character = source[index];
      if (quote !== null) {
        if (character === quote) quote = null;
        index += 1;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        index += 1;
        continue;
      }

      var operator = operatorAt(source, index);
      if (operator !== null && index + operator.length <= end) {
        start = index + operator.length;
        index += operator.length;
      } else {
        index += 1;
      }
    }

    return {
      source: source.slice(start, end),
      start: start,
      end: end,
    };
  }

  return {
    scan: scan,
    segmentAt: segmentAt,
  };
})();

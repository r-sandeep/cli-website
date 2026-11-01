// Cell-accurate layout and input state for the terminal pager. Command dispatch
// and alternate-screen ownership are intentionally handled by terminal-ext.js.
class Pager {
  static async create(renderedRecords, dimensions) {
    const pager = new Pager(renderedRecords, dimensions);
    await pager.relayout(dimensions);
    return pager;
  }

  constructor(renderedRecords, dimensions) {
    this.renderedRecords = Array.from(renderedRecords || [], (record) =>
      record == null ? "" : String(record)
    );
    this.cols = Math.max(1, Number(dimensions && dimensions.cols) || 1);
    this.rows = Math.max(2, Number(dimensions && dimensions.rows) || 2);
    this.sourceLines = Pager._sourceLines(this.renderedRecords);
    this.screenLines = [];
    this.top = 0;
    this.mode = "display";
    this.searchText = "";
    this.lastSearch = null;
    this.feedback = null;
  }

  static _sourceLines(records) {
    const lines = [];
    for (const record of records) {
      const pieces = Pager.visibleText(record).split(/\r\n|\n|\r/);
      lines.push(...pieces);
    }
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  static visibleText(text) {
    return String(text)
      .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
      .replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|[@-_])/g, "");
  }

  get pageHeight() {
    return this.rows - 1;
  }

  get total() {
    return this.screenLines.length;
  }

  get shouldPage() {
    return this.total > this.pageHeight;
  }

  get maxTop() {
    return Math.max(0, this.total - this.pageHeight);
  }

  get topSourceLine() {
    const row = this.screenLines[this.top];
    return row ? row.sourceIndex : 0;
  }

  async relayout(dimensions, anchorSourceLine = this.topSourceLine) {
    this.cols = Math.max(1, Number(dimensions && dimensions.cols) || this.cols);
    this.rows = Math.max(2, Number(dimensions && dimensions.rows) || this.rows);

    const laidOut = [];
    for (let sourceIndex = 0; sourceIndex < this.sourceLines.length; sourceIndex++) {
      const rows = await Pager._layoutSourceLine(this.sourceLines[sourceIndex], this.cols);
      for (const text of rows) laidOut.push({ text, sourceIndex });
    }
    this.screenLines = laidOut;

    const anchor = this.screenLines.findIndex(
      (row) => row.sourceIndex === anchorSourceLine
    );
    this.top = this._clampTop(anchor < 0 ? 0 : anchor);
    return this;
  }

  static async _layoutSourceLine(text, cols) {
    const measuringTerminal = new Terminal({
      cols,
      rows: 1,
      scrollback: Math.max(1000, String(text).length + 1),
    });
    try {
      await new Promise((resolve) => measuringTerminal.write(String(text), resolve));
      const buffer = measuringTerminal.buffer.active;
      const rows = [];
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y);
        if (!line) continue;
        const endColumn = y === buffer.length - 1 ? buffer.cursorX : cols;
        let value = "";
        for (let x = 0; x < endColumn; x++) {
          const cell = line.getCell(x);
          if (!cell || cell.getWidth() === 0) continue;
          value += cell.getChars() || " ";
        }
        rows.push(value);
      }
      return rows.length > 0 ? rows : [""];
    } finally {
      measuringTerminal.dispose();
    }
  }

  _clampTop(top) {
    return Math.max(0, Math.min(this.maxTop, top));
  }

  _move(delta) {
    this.top = this._clampTop(this.top + delta);
  }

  _search(pattern) {
    if (!pattern) return;
    this.lastSearch = pattern;
    const currentSource = this.topSourceLine;
    const foldedPattern = pattern.toLocaleLowerCase();
    const sourceIndex = this.sourceLines.findIndex(
      (line, index) =>
        index > currentSource && line.toLocaleLowerCase().includes(foldedPattern)
    );
    if (sourceIndex < 0) {
      this.feedback = `Pattern not found: ${pattern}`;
      return;
    }
    const rowIndex = this.screenLines.findIndex(
      (row) => row.sourceIndex === sourceIndex
    );
    this.top = this._clampTop(rowIndex);
  }

  handleKey(key) {
    if (this.mode === "search") return this._handleSearchKey(key);

    // Failure feedback lasts through the failed frame only. This key still
    // performs its normal display-mode action.
    this.feedback = null;

    if (key === "/") {
      this.mode = "search";
      this.searchText = "";
    } else if (key === "n") {
      if (this.lastSearch) this._search(this.lastSearch);
    } else if (key === " " || key === "Space" || key === "f" || key === "PageDown") {
      this._move(this.pageHeight);
    } else if (key === "b" || key === "PageUp") {
      this._move(-this.pageHeight);
    } else if (key === "ArrowDown" || key === "j" || key === "Enter") {
      this._move(1);
    } else if (key === "ArrowUp" || key === "k") {
      this._move(-1);
    } else if (key === "g" || key === "Home") {
      this.top = 0;
    } else if (key === "G" || key === "End") {
      this.top = this.maxTop;
    } else if (key === "q" || key === "Q" || key === "\x03" || key === "Ctrl+C") {
      return { handled: true, action: "close", frame: this.frame() };
    }
    return { handled: true, action: "render", frame: this.frame() };
  }

  _handleSearchKey(key) {
    if (key === "Escape" || key === "\x1b" || key === "\x03" || key === "Ctrl+C") {
      this.mode = "display";
      this.searchText = "";
    } else if (key === "Backspace" || key === "\x7f") {
      this.searchText = this.searchText.slice(0, -1);
    } else if (key === "Enter" || key === "\r") {
      const pattern = this.searchText || this.lastSearch;
      this.mode = "display";
      this.searchText = "";
      if (pattern) this._search(pattern);
    } else if (typeof key === "string" && [...key].length === 1 && key >= " ") {
      this.searchText += key;
    }
    return { handled: true, action: "render", frame: this.frame() };
  }

  frame() {
    const rows = this.screenLines
      .slice(this.top, this.top + this.pageHeight)
      .map((row) => row.text);
    const first = this.total === 0 ? 0 : this.top + 1;
    const last = this.total === 0 ? 0 : this.top + rows.length;
    let status = `lines ${first}-${last} of ${this.total}`;
    if (last === this.total) status += " (END)";
    if (this.mode === "search") status = `/${this.searchText}`;
    if (this.feedback) status = this.feedback;
    return {
      rows,
      status,
      top: this.top,
      first,
      last,
      total: this.total,
      sourceIndices: this.screenLines
        .slice(this.top, this.top + this.pageHeight)
        .map((row) => row.sourceIndex),
    };
  }

  async render(term) {
    const frame = this.frame();
    let output = "\x1b[2J";
    frame.rows.forEach((row, index) => {
      output += `\x1b[${index + 1};1H${row}`;
    });
    output += `\x1b[${this.rows};1H${frame.status}`;
    await new Promise((resolve) => term.write(output, resolve));
    return frame;
  }
}

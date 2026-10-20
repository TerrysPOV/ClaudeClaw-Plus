/**
 * What is on the terminal screen NOW, rebuilt from the bytes a PTY child wrote.
 *
 * Accumulated output is the wrong thing to judge a boot screen by: a login menu that was drawn
 * and then cleared stays in the byte stream for good, and a "Not logged in" status painted after
 * the footer is only on the screen, not before it (#570 r13, E). This is a small VT100 subset,
 * enough for claude's inline TUI: printable text, CR/LF/BS, cursor moves (CUU CUD CUF CUB CNL CPL
 * CHA CUP VPA), erase in display and in line, erase characters, save/restore cursor, and the
 * alternate-screen switch (treated as a clear). Colours, modes, titles and anything else are
 * dropped. It does not wrap wide characters by their cell width: a wide character takes one cell.
 */

const ESC = "\x1b";

export class Screen {
  private lines: string[][];
  private row = 0;
  private col = 0;
  private saved: [number, number] = [0, 0];
  /** An escape sequence that a chunk ended in the middle of. */
  private pending = "";

  constructor(
    private readonly cols = 100,
    private readonly rows = 30,
  ) {
    this.lines = Array.from({ length: rows }, () => []);
  }

  /** Apply the next chunk of output. */
  feed(data: string): void {
    const text = this.pending + data;
    this.pending = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (ch === ESC) {
        const consumed = this.escape(text, i);
        if (consumed === 0) {
          this.pending = text.slice(i, i + 4096); // incomplete: finish it with the next chunk
          return;
        }
        i += consumed - 1;
        continue;
      }
      this.put(ch);
    }
  }

  /** The visible screen, one string per row, trailing blanks removed, empty rows at the end dropped. */
  text(): string {
    const rows = this.lines.map((cells) => {
      let out = "";
      for (const cell of cells) out += cell === undefined ? " " : cell;
      return out.trimEnd();
    });
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows.join("\n");
  }

  private put(ch: string): void {
    if (ch === "\r") {
      this.col = 0;
    } else if (ch === "\n") {
      this.lineFeed();
    } else if (ch === "\b") {
      this.col = Math.max(0, this.col - 1);
    } else if (ch === "\t") {
      this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
    } else if (ch >= " " && ch !== "\x7f") {
      if (this.col >= this.cols) {
        this.col = 0;
        this.lineFeed();
      }
      (this.lines[this.row] as string[])[this.col] = ch;
      this.col++;
    }
  }

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row++;
      return;
    }
    this.lines.shift();
    this.lines.push([]);
  }

  /** Returns how many characters of `text` from `at` it consumed, or 0 when the sequence is incomplete. */
  private escape(text: string, at: number): number {
    const kind = text[at + 1];
    if (kind === undefined) return 0;
    if (kind === "[") {
      for (let j = at + 2; j < text.length; j++) {
        const code = text.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) {
          this.csi(text.slice(at + 2, j), text[j] as string);
          return j - at + 1;
        }
      }
      return 0;
    }
    if (kind === "]") {
      for (let j = at + 2; j < text.length; j++) {
        if (text[j] === "\x07") return j - at + 1;
        if (text[j] === ESC && text[j + 1] === "\\") return j - at + 2;
        if (text[j] === ESC && j + 1 >= text.length) return 0;
      }
      return 0;
    }
    if (kind === "(" || kind === ")") return at + 2 < text.length ? 3 : 0;
    if (kind === "7") this.saved = [this.row, this.col];
    else if (kind === "8") [this.row, this.col] = this.saved;
    return 2;
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?")) {
      // 1049/47/1047 switch to the alternate screen, which starts empty.
      if (final === "h" && /^\?(1049|1047|47)$/.test(params)) this.clearAll();
      return;
    }
    const n = params.split(";").map((p) => (p === "" ? Number.NaN : Number.parseInt(p, 10)));
    const arg = (i: number, fallback: number): number => {
      const value = n[i];
      return value === undefined || Number.isNaN(value) ? fallback : value;
    };
    const clampRow = (r: number): number => Math.min(this.rows - 1, Math.max(0, r));
    const clampCol = (c: number): number => Math.min(this.cols - 1, Math.max(0, c));
    switch (final) {
      case "A":
        this.row = clampRow(this.row - arg(0, 1));
        break;
      case "B":
        this.row = clampRow(this.row + arg(0, 1));
        break;
      case "C":
        this.col = clampCol(this.col + arg(0, 1));
        break;
      case "D":
        this.col = clampCol(this.col - arg(0, 1));
        break;
      case "E":
        this.row = clampRow(this.row + arg(0, 1));
        this.col = 0;
        break;
      case "F":
        this.row = clampRow(this.row - arg(0, 1));
        this.col = 0;
        break;
      case "G":
        this.col = clampCol(arg(0, 1) - 1);
        break;
      case "d":
        this.row = clampRow(arg(0, 1) - 1);
        break;
      case "H":
      case "f":
        this.row = clampRow(arg(0, 1) - 1);
        this.col = clampCol(arg(1, 1) - 1);
        break;
      case "J":
        this.eraseDisplay(arg(0, 0));
        break;
      case "K":
        this.eraseLine(arg(0, 0));
        break;
      case "X": {
        const cells = this.lines[this.row] as string[];
        for (let c = this.col; c < Math.min(this.cols, this.col + arg(0, 1)); c++) delete cells[c];
        break;
      }
      case "s":
        this.saved = [this.row, this.col];
        break;
      case "u":
        [this.row, this.col] = this.saved;
        break;
      default:
        break; // colours (m), modes, scrolling, insert/delete: not modelled
    }
  }

  private clearAll(): void {
    this.lines = Array.from({ length: this.rows }, () => []);
    this.row = 0;
    this.col = 0;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = Array.from({ length: this.rows }, () => []);
    } else if (mode === 0) {
      this.eraseLine(0);
      for (let r = this.row + 1; r < this.rows; r++) this.lines[r] = [];
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let r = 0; r < this.row; r++) this.lines[r] = [];
    }
  }

  private eraseLine(mode: number): void {
    const cells = this.lines[this.row] as string[];
    if (mode === 2) this.lines[this.row] = [];
    else if (mode === 0) cells.length = Math.min(cells.length, this.col);
    else if (mode === 1) for (let c = 0; c <= this.col && c < cells.length; c++) delete cells[c];
  }
}

export interface MotionBuffer {
  readonly lines: readonly string[];
  readonly tabstop: number;
  readonly top?: number;
  readonly height?: number;
}

export const MAXCOL = Number.MAX_SAFE_INTEGER;

export interface Pos { line: number; col: number }

export type MotionType = 'char' | 'line';

export interface MotionResult {
  readonly pos: Pos;
  readonly type: MotionType;
  readonly inclusive: boolean;
  readonly want?: number;
  readonly keepWant?: boolean;
  readonly failed?: boolean;
  readonly noAdjustEnd?: boolean;
}

export interface FindState {
  char: string;
  forward: boolean;
  until: boolean;
}

export interface MotionRequest {
  readonly key: string;
  readonly count: number | undefined;
  readonly arg?: string;
  readonly want: number;
  readonly operator: boolean;
  readonly change: boolean;
  readonly visual: boolean;
  readonly lastFind: FindState | null;
}

export function isWhite(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

function isKeywordChar(ch: string): boolean {
  return /[A-Za-z0-9_À-￿]/.test(ch);
}

export function charClassAt(line: string, col: number, big: boolean): 0 | 1 | 2 {
  const ch = line[col];
  if (ch === undefined || ch === ' ' || ch === '\t') return 0;
  if (big) return 1;
  return isKeywordChar(ch) ? 2 : 1;
}

export function charCells(ch: string, vcol: number, tabstop: number): number {
  if (ch === '\t') return tabstop - (vcol % tabstop);
  const code = ch.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return 2;
  return 1;
}

export function cursorVcol(line: string, col: number, tabstop: number, normalMode = true): number {
  let vcol = 0;
  for (let i = 0; i < col && i < line.length; i++) vcol += charCells(line[i], vcol, tabstop);
  if (col < line.length) {
    const width = charCells(line[col], vcol, tabstop);
    if (line[col] === '\t' && normalMode) return vcol + width - 1;
  }
  return vcol;
}

export function colAtVcol(line: string, want: number, tabstop: number, allowEol = false): number {
  const last = allowEol ? line.length : Math.max(0, line.length - 1);
  if (want >= MAXCOL) return last;
  let vcol = 0;
  for (let i = 0; i < line.length; i++) {
    const width = charCells(line[i], vcol, tabstop);
    if (want < vcol + width) return i;
    vcol += width;
  }
  return last;
}

export function firstNonBlank(line: string, keepOffEnd = true): number {
  let col = 0;
  while (col < line.length && isWhite(line[col]) && !(keepOffEnd && col + 1 >= line.length)) col++;
  return col;
}

export class Cursor {
  constructor(private readonly buf: MotionBuffer, public line: number, public col: number) {}

  text(): string { return this.buf.lines[this.line] ?? ''; }
  lastLine(): number { return this.buf.lines.length - 1; }

  cls(big: boolean): 0 | 1 | 2 { return charClassAt(this.text(), this.col, big); }

  inc(): number {
    const text = this.text();
    if (this.col < text.length) {
      this.col++;
      return this.col < text.length ? 0 : 2;
    }
    if (this.line < this.lastLine()) {
      this.line++;
      this.col = 0;
      return 1;
    }
    return -1;
  }

  dec(): number {
    if (this.col > 0) {
      this.col--;
      return 0;
    }
    if (this.line > 0) {
      this.line--;
      this.col = this.text().length;
      return 1;
    }
    return -1;
  }

  emptyLine(): boolean { return this.text().length === 0; }

  incl(): number {
    let r = this.inc();
    if (r >= 1 && this.col > 0) r = this.inc();
    return r;
  }

  decl(): number {
    let r = this.dec();
    if (r === 1 && this.col > 0) r = this.dec();
    return r;
  }

  oneLeft(): boolean {
    if (this.col === 0) return false;
    this.col--;
    return true;
  }

  inIndent(extra: number): boolean {
    const text = this.text();
    let white = 0;
    while (white < text.length && isWhite(text[white])) white++;
    return white >= this.col + extra;
  }

  backInLine(big: boolean): void {
    const sclass = this.cls(big);
    for (;;) {
      if (this.col === 0) break;
      this.dec();
      if (this.cls(big) !== sclass) {
        this.inc();
        break;
      }
    }
  }

  pos(): Pos { return { line: this.line, col: this.col }; }

  skipChars(cls: number, big: boolean, forward: boolean): boolean {
    while (this.cls(big) === cls) {
      if ((forward ? this.inc() : this.dec()) === -1) return true;
    }
    return false;
  }
}

export function fwdWord(c: Cursor, count: number, big: boolean, eol: boolean): boolean {
  let remaining = count;
  while (--remaining >= 0) {
    const sclass = c.cls(big);
    const lastLine = c.line === c.lastLine();
    const i = c.inc();
    if (i === -1 || (i >= 1 && lastLine)) return false;
    if (i >= 1 && eol && remaining === 0) return true;
    if (sclass !== 0) {
      while (c.cls(big) === sclass) {
        const j = c.inc();
        if (j === -1 || (j >= 1 && eol && remaining === 0)) return true;
      }
    }
    while (c.cls(big) === 0) {
      if (c.col === 0 && c.emptyLine()) break;
      const j = c.inc();
      if (j === -1 || (j >= 1 && eol && remaining === 0)) return true;
    }
  }
  return true;
}

export function bckWord(c: Cursor, count: number, big: boolean, stopIn: boolean): boolean {
  let stop = stopIn;
  let remaining = count;
  while (--remaining >= 0) {
    const sclass = c.cls(big);
    if (c.dec() === -1) return false;
    let finished = false;
    if (!stop || sclass === c.cls(big) || sclass === 0) {
      while (c.cls(big) === 0) {
        if (c.col === 0 && c.emptyLine()) { finished = true; break; }
        if (c.dec() === -1) return true;
      }
      if (!finished && c.skipChars(c.cls(big), big, false)) return true;
    }
    if (!finished) c.inc();
    stop = false;
  }
  return true;
}

export function endWord(c: Cursor, count: number, big: boolean, stopIn: boolean, empty: boolean): boolean {
  let stop = stopIn;
  let remaining = count;
  while (--remaining >= 0) {
    const sclass = c.cls(big);
    if (c.inc() === -1) return false;
    let finished = false;
    if (c.cls(big) === sclass && sclass !== 0) {
      if (c.skipChars(sclass, big, true)) return false;
    } else if (!stop || sclass === 0) {
      while (c.cls(big) === 0) {
        if (empty && c.col === 0 && c.emptyLine()) { finished = true; break; }
        if (c.inc() === -1) return false;
      }
      if (!finished && c.skipChars(c.cls(big), big, true)) return false;
    }
    if (!finished) c.dec();
    stop = false;
  }
  return true;
}

export function bckendWord(c: Cursor, count: number, big: boolean, eol: boolean): boolean {
  let remaining = count;
  while (--remaining >= 0) {
    const sclass = c.cls(big);
    let i = c.dec();
    if (i === -1) return false;
    if (eol && i === 1) return true;
    if (sclass !== 0) {
      while (c.cls(big) === sclass) {
        i = c.dec();
        if (i === -1 || (eol && i === 1)) return true;
      }
    }
    while (c.cls(big) === 0) {
      if (c.col === 0 && c.emptyLine()) break;
      i = c.dec();
      if (i === -1 || (eol && i === 1)) return true;
    }
  }
  return true;
}


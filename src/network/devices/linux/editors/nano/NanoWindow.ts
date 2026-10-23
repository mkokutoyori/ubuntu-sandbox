import { actualX, advanceOver, isBlankChar, wideness } from './NanoText';

export type ViewportManner = 'flowing' | 'centering' | 'recentering' | 'stationary';

export interface NanoBuffer {
  lineCount(): number;
  lineAt(index: number): string;
}

export interface NanoWindowSettings {
  readonly softwrap: boolean;
  readonly tabsize: number;
  readonly lineNumbers: boolean;
  readonly zero: boolean;
  readonly minibar: boolean;
  readonly emptyline: boolean;
  readonly nohelp: boolean;
  readonly jumpyscrolling: boolean;
  readonly atblanks: boolean;
  readonly indicator: boolean;
}

export interface NanoLayoutFlags {
  readonly zero: boolean;
  readonly minibar: boolean;
  readonly emptyline: boolean;
  readonly nohelp: boolean;
}

export interface Position {
  readonly line: number;
  readonly col: number;
}

export interface ScreenPosition {
  readonly row: number;
  readonly column: number;
}

const HIGHEST = Number.MAX_SAFE_INTEGER;

export interface NanoLayout {
  readonly titleRows: number;
  readonly editFrom: number;
  readonly editRows: number;
  readonly statusRow: number;
  readonly barsFrom: number | null;
}

export const SHORTCUT_BARS_MINIMUM = 6;

export const PLAIN_LAYOUT: NanoLayoutFlags = { zero: false, minibar: false, emptyline: false, nohelp: false };

export function nanoLayout(rows: number, flags: NanoLayoutFlags = PLAIN_LAYOUT): NanoLayout {
  if (rows < 3) return { titleRows: 0, editFrom: 0, editRows: flags.zero ? rows : 1, statusRow: rows - 1, barsFrom: null };
  const bottomRows = flags.nohelp || rows < SHORTCUT_BARS_MINIMUM ? 1 : 3;
  const titleRows = flags.minibar || flags.zero ? 0 : flags.emptyline && rows > SHORTCUT_BARS_MINIMUM ? 2 : 1;
  const editRows = rows - titleRows - bottomRows + (flags.zero ? 1 : 0);
  const statusRow = rows - bottomRows;
  return { titleRows, editFrom: titleRows, editRows, statusRow, barsFrom: bottomRows === 3 ? statusRow + 1 : null };
}

export class NanoWindow {
  rows = 24;
  cols = 80;
  edittop = 0;
  firstcolumn = 0;
  cursorRow = 0;

  constructor(
    private readonly buffer: NanoBuffer,
    private readonly settings: () => NanoWindowSettings,
  ) {}

  get layout(): NanoLayout { return nanoLayout(this.rows, this.settings()); }

  get editRows(): number { return this.layout.editRows; }

  get margin(): number {
    if (!this.settings().lineNumbers) return 0;
    const needed = Math.max(2, String(this.buffer.lineCount()).length) + 1;
    return needed > this.cols - 4 ? 0 : needed;
  }

  get sidebar(): number { return this.settings().indicator && this.rows > 5 && this.cols > 9 ? 1 : 0; }

  get editCols(): number { return this.cols - this.margin - this.sidebar; }

  get hasTitleBar(): boolean { return this.layout.titleRows > 0; }

  get hasShortcutBars(): boolean { return this.layout.barsFrom !== null; }

  private get tabsize(): number { return this.settings().tabsize; }

  private get softwrap(): boolean { return this.settings().softwrap; }

  columnOf(line: number, col: number): number {
    return wideness(this.buffer.lineAt(line), col, this.tabsize);
  }

  pageStart(column: number): number {
    const width = this.editCols;
    if (column === 0 || column + 2 < width || this.softwrap) return 0;
    if (width > 8) return column - 6 - ((column - 6) % (width - 8));
    return column - (width - 2);
  }

  breakpoint(text: string, leftedge: number): { end: number; endOfLine: boolean } {
    const rightside = leftedge + this.editCols;
    const atBlanks = this.settings().atblanks;
    let index = 0;
    let column = 0;
    while (index < text.length && column < leftedge) {
      const step = advanceOver(text, index, column, this.tabsize);
      column += step.width;
      index += step.length;
    }
    let breaking = rightside;
    let lastBlankColumn = 0;
    let farthestBlank = -1;
    while (index < text.length && column <= rightside) {
      if (atBlanks && isBlankChar(text[index]) && column < rightside) {
        farthestBlank = index;
        lastBlankColumn = column;
      }
      breaking = text[index] === '\t' ? rightside : column;
      const step = advanceOver(text, index, column, this.tabsize);
      column += step.width;
      index += step.length;
    }
    if (column <= rightside) return { end: column, endOfLine: column < rightside };
    if (farthestBlank >= 0) {
      const afterTheBlank = lastBlankColumn + advanceOver(text, farthestBlank, lastBlankColumn, this.tabsize).width;
      if (afterTheBlank <= rightside) return { end: afterTheBlank, endOfLine: false };
      if (text[farthestBlank] === '\t') breaking = rightside;
    }
    return { end: this.editCols > 1 ? breaking : column - 1, endOfLine: false };
  }

  chunkAndEdge(column: number, line: number): { chunk: number; leftedge: number } {
    const text = this.buffer.lineAt(line);
    let chunk = 0;
    let start = 0;
    for (;;) {
      const { end, endOfLine } = this.breakpoint(text, start);
      if (endOfLine || (start <= column && column < end)) return { chunk, leftedge: start };
      start = end;
      chunk++;
    }
  }

  extraChunksIn(line: number): number { return this.chunkAndEdge(HIGHEST, line).chunk; }

  chunkFor(column: number, line: number): number { return this.chunkAndEdge(column, line).chunk; }

  leftedgeFor(column: number, line: number): number { return this.chunkAndEdge(column, line).leftedge; }

  goForward(nrows: number, at: { line: number; leftedge: number }): number {
    if (!this.softwrap) {
      let i = nrows;
      while (i > 0 && at.line < this.buffer.lineCount() - 1) { at.line++; i--; }
      return i;
    }
    let current = at.leftedge;
    let i = nrows;
    for (; i > 0; i--) {
      const { end, endOfLine } = this.breakpoint(this.buffer.lineAt(at.line), current);
      current = end;
      if (!endOfLine) continue;
      if (at.line === this.buffer.lineCount() - 1) break;
      at.line++;
      current = 0;
    }
    if (i < nrows) at.leftedge = current;
    return i;
  }

  goBack(nrows: number, at: { line: number; leftedge: number }): number {
    if (!this.softwrap) {
      let i = nrows;
      while (i > 0 && at.line > 0) { at.line--; i--; }
      return i;
    }
    let i = nrows;
    for (; i > 0; i--) {
      const chunk = this.chunkFor(at.leftedge, at.line);
      at.leftedge = 0;
      if (chunk >= i) return this.goForward(chunk - i, at);
      if (at.line === 0) break;
      i -= chunk;
      at.line--;
      at.leftedge = HIGHEST;
    }
    if (at.leftedge === HIGHEST) at.leftedge = this.leftedgeFor(at.leftedge, at.line);
    return i;
  }

  isAbove(current: Position): boolean {
    if (this.softwrap) {
      return current.line < this.edittop
        || (current.line === this.edittop && this.columnOf(current.line, current.col) < this.firstcolumn);
    }
    return current.line < this.edittop;
  }

  isBelow(current: Position): boolean {
    if (this.softwrap) {
      const at = { line: this.edittop, leftedge: this.firstcolumn };
      return this.goForward(this.editRows - 1, at) === 0
        && (at.line < current.line
          || (at.line === current.line && at.leftedge < this.leftedgeFor(this.columnOf(current.line, current.col), current.line)));
    }
    return current.line >= this.edittop + this.editRows;
  }

  isOffscreen(current: Position): boolean { return this.isAbove(current) || this.isBelow(current); }

  adjust(manner: ViewportManner, current: Position): void {
    let goal = 0;
    if (manner === 'stationary') goal = this.cursorRow;
    else if (manner === 'centering' || manner === 'recentering') goal = Math.floor(this.editRows / 2);
    else if (!this.isAbove(current)) goal = this.editRows - 1;
    const at = { line: current.line, leftedge: 0 };
    if (this.softwrap) at.leftedge = this.leftedgeFor(this.columnOf(current.line, current.col), current.line);
    this.goBack(goal, at);
    this.edittop = at.line;
    this.firstcolumn = this.softwrap ? at.leftedge : 0;
  }

  scroll(forward: boolean): void {
    const at = { line: this.edittop, leftedge: this.firstcolumn };
    if (forward) this.goForward(1, at);
    else this.goBack(1, at);
    this.edittop = at.line;
    this.firstcolumn = at.leftedge;
  }

  hugFloor(current: Position): void {
    const half = Math.floor(this.editRows / 2);
    let rowsFromTail: number;
    if (this.softwrap) {
      const at = { line: current.line, leftedge: this.leftedgeFor(this.columnOf(current.line, current.col), current.line) };
      rowsFromTail = half - this.goForward(half, at);
    } else {
      rowsFromTail = this.buffer.lineCount() - 1 - current.line;
    }
    if (rowsFromTail < half && !this.settings().jumpyscrolling) {
      this.cursorRow = this.editRows - 1 - rowsFromTail;
      this.adjust('stationary', current);
    } else {
      this.adjust('centering', current);
    }
    this.cursorRow = this.place(current).row;
  }

  follow(manner: ViewportManner, current: Position): void {
    if (manner === 'stationary' || manner === 'recentering') this.adjust(manner, current);
    else if (this.isOffscreen(current)) this.adjust(this.settings().jumpyscrolling ? 'centering' : manner, current);
    this.cursorRow = this.place(current).row;
  }

  place(current: Position): ScreenPosition {
    const column = this.columnOf(current.line, current.col);
    if (this.softwrap) {
      let row = -this.chunkFor(this.firstcolumn, this.edittop);
      for (let line = this.edittop; line < current.line; line++) row += 1 + this.extraChunksIn(line);
      const { chunk, leftedge } = this.chunkAndEdge(column, current.line);
      return { row: row + chunk, column: column - leftedge };
    }
    return { row: current.line - this.edittop, column: column - this.pageStart(column) };
  }

  align(): void {
    this.firstcolumn = this.softwrap ? this.leftedgeFor(this.firstcolumn, this.edittop) : 0;
  }

  resize(rows: number, cols: number, current: Position): void {
    this.rows = rows;
    this.cols = cols;
    this.align();
    this.follow('flowing', current);
  }

  edgeAndTarget(current: Position, placeWant: number): { leftedge: number; target: number } {
    if (!this.softwrap) return { leftedge: 0, target: placeWant };
    const shim = this.editCols * (1 + Math.floor(this.tabsize / this.editCols));
    const leftedge = this.leftedgeFor(this.columnOf(current.line, current.col), current.line);
    return { leftedge, target: (placeWant + shim - leftedge) % this.editCols };
  }

  private actualLastColumn(line: number, leftedge: number, column: number): number {
    if (!this.softwrap) return leftedge + column;
    const { end, endOfLine } = this.breakpoint(this.buffer.lineAt(line), leftedge);
    let last = end - leftedge;
    if (!endOfLine) last--;
    return leftedge + Math.min(column, last);
  }

  private properIndex(
    line: number, edge: { leftedge: number }, forward: boolean, column: number,
  ): { index: number; shifted: boolean } {
    const text = this.buffer.lineAt(line);
    let index = actualX(text, column, this.tabsize);
    let shifted = false;
    if (this.softwrap && text[index] === '	'
      && ((forward && wideness(text, index, this.tabsize) < edge.leftedge)
        || (!forward
          && Math.floor(column / this.tabsize) === Math.floor((edge.leftedge - 1) / this.tabsize)
          && Math.floor(column / this.tabsize) < Math.floor((edge.leftedge + this.editCols - 1) / this.tabsize)))) {
      index++;
      shifted = true;
    }
    if (this.softwrap) edge.leftedge = this.leftedgeFor(wideness(text, index, this.tabsize), line);
    return { index, shifted };
  }

  chunkLeft(line: number, column: number): { index: number; leftedge: number } {
    const edge = { leftedge: this.leftedgeFor(column, line) };
    const start = edge.leftedge;
    const { index } = this.properIndex(line, edge, false, start);
    return { index, leftedge: start };
  }

  chunkRight(line: number, column: number): { index: number; rightedge: number; last: boolean } {
    const text = this.buffer.lineAt(line);
    const leftedge = this.leftedgeFor(column, line);
    const { end, endOfLine } = this.breakpoint(text, leftedge);
    const rightedge = endOfLine ? end : end - 1;
    return { index: actualX(text, rightedge, this.tabsize), rightedge, last: endOfLine };
  }

  landOn(line: number, leftedge: number, target: number, forward: boolean): { col: number; placeWant: number } {
    const edge = { leftedge };
    const wasEdge = leftedge;
    let result = this.properIndex(line, edge, forward, this.actualLastColumn(line, edge.leftedge, target));
    if (result.shifted || edge.leftedge < wasEdge) {
      result = this.properIndex(line, edge, forward, this.actualLastColumn(line, edge.leftedge, target));
    }
    return { col: result.index, placeWant: edge.leftedge + target };
  }
}

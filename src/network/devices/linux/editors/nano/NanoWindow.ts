import { actualX, advanceOver, wideness } from './NanoText';

export type ViewportManner = 'flowing' | 'centering' | 'recentering' | 'stationary';

export interface NanoBuffer {
  lineCount(): number;
  lineAt(index: number): string;
}

export interface NanoWindowSettings {
  readonly softwrap: boolean;
  readonly tabsize: number;
  readonly lineNumbers: boolean;
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
  readonly titleRow: number | null;
  readonly editFrom: number;
  readonly editRows: number;
  readonly statusRow: number;
  readonly barsFrom: number | null;
}

export function nanoLayout(rows: number): NanoLayout {
  if (rows < 3) return { titleRow: null, editFrom: 0, editRows: 1, statusRow: rows - 1, barsFrom: null };
  const bars = rows >= 5;
  const editRows = rows - 1 - (bars ? 3 : 1);
  return { titleRow: 0, editFrom: 1, editRows, statusRow: 1 + editRows, barsFrom: bars ? rows - 2 : null };
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

  get editRows(): number { return nanoLayout(this.rows).editRows; }

  get margin(): number {
    if (!this.settings().lineNumbers) return 0;
    const needed = Math.max(2, String(this.buffer.lineCount()).length) + 1;
    return needed > this.cols - 4 ? 0 : needed;
  }

  get editCols(): number { return this.cols - this.margin; }

  get hasTitleBar(): boolean { return this.rows >= 3; }

  get hasShortcutBars(): boolean { return this.rows >= 5; }

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
    let index = 0;
    let column = 0;
    while (index < text.length && column < leftedge) {
      const step = advanceOver(text, index, column, this.tabsize);
      column += step.width;
      index += step.length;
    }
    let breaking = rightside;
    while (index < text.length && column <= rightside) {
      breaking = text[index] === '\t' ? rightside : column;
      const step = advanceOver(text, index, column, this.tabsize);
      column += step.width;
      index += step.length;
    }
    if (column <= rightside) return { end: column, endOfLine: column < rightside };
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

  follow(manner: ViewportManner, current: Position): void {
    if (manner === 'stationary' || manner === 'recentering' || this.isOffscreen(current)) this.adjust(manner, current);
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

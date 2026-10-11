import { MAXCOL, type Pos } from './VimCursor';
import type { WindowView } from './VimWindow';

export interface ScreenMove {
  readonly pos: Pos;
  readonly want: number;
  readonly failed: boolean;
}

function wholeLines(view: WindowView, line: number): number {
  return view.cellCount(line);
}

export function screenGo(
  view: WindowView, lineCount: number, from: Pos, forward: boolean, distance: number, want: number, allowEol: boolean,
): ScreenMove {
  const width1 = view.textWidth;
  const width2 = width1;
  let curswant = want;
  let line = from.line;
  let linelen = wholeLines(view, line);
  if (curswant >= MAXCOL) {
    const virt = view.virtColumn(from.line, from.col, true);
    curswant = width1 - 1;
    if (virt > curswant) curswant += (Math.floor((virt - curswant - 1) / width2) + 1) * width2;
  } else {
    const n = linelen > width1 ? (Math.floor((linelen - width1 - 1) / width2) + 1) * width2 + width1 : width1;
    if (curswant >= n) curswant = n - 1;
  }
  let failed = false;
  for (let step = 0; step < distance; step++) {
    if (!forward) {
      if (curswant >= width1) {
        curswant -= width2;
      } else {
        if (line <= 0) { failed = true; break; }
        line--;
        linelen = wholeLines(view, line);
        if (linelen > width1) curswant += (Math.floor((linelen - width1 - 1) / width2) + 1) * width2;
      }
    } else {
      const n = linelen > width1 ? (Math.floor((linelen - width1 - 1) / width2) + 1) * width2 + width1 : width1;
      if (curswant + width2 < n) {
        curswant += width2;
      } else {
        if (line >= lineCount - 1) { failed = true; break; }
        line++;
        curswant %= width2;
        if (curswant >= width1) curswant -= width2;
        linelen = wholeLines(view, line);
      }
    }
  }
  let col = view.colAtCell(line, curswant, allowEol);
  if (col > 0 && view.wraps) {
    const virt = view.virtColumn(line, col, true);
    const split = curswant < width1 ? curswant > Math.floor(width1 / 2) : (curswant - width1) % width2 > Math.floor(width2 / 2);
    if (virt > curswant && split) col--;
  }
  return { pos: { line, col }, want: curswant, failed };
}

export function screenLineStart(view: WindowView, from: Pos, skipBlanks: boolean, middle: boolean, text: string): Pos {
  const virt = view.virtColumn(from.line, from.col, true);
  const width1 = view.textWidth;
  let cell = view.wraps ? (virt >= width1 ? Math.floor((virt - width1) / width1) * width1 + width1 : 0) : view.leftCol;
  if (middle) cell += Math.floor(width1 / 2);
  let col = view.colAtCell(from.line, cell, false);
  if (skipBlanks) {
    while (col < text.length - 1 && (text[col] === ' ' || text[col] === '\t')) col++;
  }
  return { line: from.line, col };
}

export function screenLineEnd(view: WindowView, from: Pos, count: number, lineCount: number, text: string, allowEol: boolean): ScreenMove {
  if (view.wraps) {
    if (count > 1) return screenGo(view, lineCount, from, true, count - 1, MAXCOL, allowEol);
    const width1 = view.textWidth;
    const virt = view.virtColumn(from.line, from.col, true);
    let cell = width1 - 1;
    if (virt >= width1) cell += (Math.floor((virt - width1) / width1) + 1) * width1;
    let col = view.colAtCell(from.line, cell, allowEol);
    if (col > 0) {
      const landed = view.virtColumn(from.line, col, true);
      if (landed > cell + 1) col--;
    }
    return { pos: { line: from.line, col }, want: view.virtColumn(from.line, col, true), failed: false };
  }
  const line = Math.min(lineCount - 1, from.line + Math.max(0, count - 1));
  const cell = view.leftCol + view.textWidth - 1;
  let col = view.colAtCell(line, cell, allowEol);
  const lineText = line === from.line ? text : '';
  void lineText;
  if (col > 0) {
    const landed = view.virtColumn(line, col, true);
    if (landed >= view.leftCol + view.textWidth) col--;
  }
  return { pos: { line, col }, want: view.virtColumn(line, col, true), failed: false };
}

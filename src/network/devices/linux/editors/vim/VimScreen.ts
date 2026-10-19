import { EDGE_MARK_COL, codePointWidth, parseListChars, type Cell, type ListSpec } from './VimCells';
import type { VimWindow } from './VimWindow';
import type { HighlightSpan } from './VimSearch';
import { CONTINUATION, type EditorScreen, type ScreenRow, type ScreenSpan, type ScreenStyle } from '../screen/EditorScreen';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export interface ScreenVisual {
  readonly mode: 'visual' | 'visual-line' | 'visual-block';
  readonly anchor: { readonly line: number; readonly col: number };
}

export interface ScreenInput {
  readonly lines: readonly string[];
  readonly cursor: { readonly line: number; readonly col: number };
  readonly tabEnd: boolean;
  readonly visual: ScreenVisual | null;
  readonly searchSpans: ReadonlyMap<number, readonly HighlightSpan[]> | null;
  readonly incSearchSpans: ReadonlyMap<number, readonly HighlightSpan[]> | null;
  readonly colorcolumn: string;
  readonly textwidth: number;
  readonly list: boolean;
  readonly listchars: string;
  readonly number: boolean;
  readonly relativenumber: boolean;
  readonly display: string;
  readonly commandLine: { readonly prompt: string; readonly text: string } | null;
  readonly message: string;
  readonly messageStyle: ScreenStyle | null;
  readonly ruler: boolean;
  readonly showcmd: string | null;
  readonly rulerPosition: string;
  readonly cursorAt: { readonly line: number; readonly col: number } | null;
}

const RULER_WIDTH = 18;
const SHOWCMD_WIDTH = 10;

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function rowText(cells: readonly Cell[]): string {
  return cells.map((cell) => (cell.ch === '' ? CONTINUATION : cell.ch)).join('');
}

function cellsWidth(text: string): number {
  let total = 0;
  for (const ch of text) total += codePointWidth(ch.codePointAt(0)!);
  return total;
}

function colorColumns(spec: string, textwidth: number): number[] {
  if (spec === '') return [];
  const found: number[] = [];
  for (const item of spec.split(',')) {
    const value = parseInt(item, 10);
    if (item.startsWith('+') || item.startsWith('-')) {
      if (textwidth > 0) found.push(textwidth + value);
    } else if (value > 0) {
      found.push(value);
    }
  }
  return found;
}

function selectedRanges(window: VimWindow, input: ScreenInput, line: number, cells: readonly Cell[]): [number, number][] {
  const visual = input.visual;
  if (!visual) return [];
  const a = visual.anchor;
  const c = input.cursor;
  const startsFirst = a.line < c.line || (a.line === c.line && a.col <= c.col);
  const start = startsFirst ? a : c;
  const end = startsFirst ? c : a;
  if (line < start.line || line > end.line) return [];
  const text = input.lines[line] ?? '';
  const cellRange = (from: number, to: number): [number, number] | null => {
    let first = -1;
    let last = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].col >= from && cells[i].col <= to) {
        if (first < 0) first = i;
        last = i;
      }
    }
    return first < 0 ? null : [first, last + 1];
  };
  if (visual.mode === 'visual-line') {
    const whole = cellRange(0, Math.max(0, text.length - 1));
    return [whole ? [whole[0], whole[1] + 1] : [0, 1]];
  }
  if (visual.mode === 'visual') {
    const from = line === start.line ? start.col : 0;
    const to = line === end.line ? end.col : Math.max(0, text.length - 1);
    const range = cellRange(from, to);
    const toEol = line < end.line;
    if (range) return [toEol ? [range[0], range[1] + 1] : range];
    return toEol ? [[cells.length, cells.length + 1]] : [];
  }
  const aSpan = window.cursorSpan(a.line, a.col, false);
  const cSpan = window.cursorSpan(c.line, c.col, false);
  let from = Math.min(aSpan.start, cSpan.start);
  let to = Math.max(aSpan.end, cSpan.end) + 1;
  while (from > 0 && cells[from]?.ch === '') from--;
  while (to < cells.length && cells[to]?.ch === '') to++;
  return [[from, to]];
}

function withoutCursor(ranges: readonly [number, number][], window: VimWindow, input: ScreenInput): [number, number][] {
  const { start, end, virt } = window.cursorSpan(input.cursor.line, input.cursor.col, input.tabEnd);
  const onTab = (input.lines[input.cursor.line] ?? '')[input.cursor.col] === '\t';
  const first = onTab ? virt : start;
  const last = onTab ? virt : end;
  const out: [number, number][] = [];
  for (const [from, to] of ranges) {
    if (last < from || first >= to) { out.push([from, to]); continue; }
    if (from < first) out.push([from, first]);
    if (last + 1 < to) out.push([last + 1, to]);
  }
  return out;
}

function searchRanges(cells: readonly Cell[], spans: readonly HighlightSpan[] | undefined, textLength: number, eolIndex: number): [number, number][] {
  if (spans === undefined) return [];
  const ranges: [number, number][] = [];
  for (const span of spans) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].col >= span.from && cells[i].col < span.to) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) ranges.push([first, last + 1]);
    if (span.from <= textLength && span.to > textLength) ranges.push([eolIndex, eolIndex + 1]);
  }
  return ranges;
}

function numberLabel(input: ScreenInput, lnum: number, width: number): string {
  const absolute = lnum + 1;
  const relative = Math.abs(lnum - input.cursor.line);
  if (input.number && !input.relativenumber) return `${padToWidth(String(absolute), width, 'right')} `;
  if (input.relativenumber && !input.number) return `${padToWidth(String(relative), width, 'right')} `;
  if (relative === 0) return `${padToWidth(String(absolute), width)} `;
  return `${padToWidth(String(relative), width, 'right')} `;
}

function trimEdges(slice: Cell[], all: readonly Cell[], offset: number, spec: ListSpec | null): Cell[] {
  const out = [...slice];
  if (out.length > 0 && out[0].ch === '') out[0] = { ch: '<', style: 'special', col: EDGE_MARK_COL, first: false };
  const last = out.length - 1;
  const next = all[offset + out.length];
  if (last >= 0 && next !== undefined) {
    if (next.ch === '' && out[last].ch !== '') out[last] = { ch: '>', style: 'special', col: EDGE_MARK_COL, first: false };
    else if (spec !== null && spec.extends !== null && out[last].ch !== '') out[last] = { ch: spec.extends, style: 'special', col: EDGE_MARK_COL, first: false };
  }
  if (spec !== null && spec.precedes !== null && offset > 0 && out.length > 0) out[0] = { ch: spec.precedes, style: 'special', col: EDGE_MARK_COL, first: false };
  return out;
}

function cellStyles(
  slice: readonly Cell[], offset: number, selection: readonly [number, number][], found: readonly [number, number][], incremental: readonly [number, number][], columns: readonly number[], textWidth: number,
): ScreenSpan[] {
  const kinds: (ScreenStyle | null)[] = slice.map((cell) => (cell.style === 'special' ? 'special' : null));
  for (const [from, to] of found) {
    for (let i = Math.max(0, from - offset); i < to - offset && i < textWidth; i++) {
      if (slice[i] !== undefined && slice[i].col === EDGE_MARK_COL) continue;
      while (kinds.length <= i) kinds.push(null);
      kinds[i] = 'search';
    }
  }
  for (const [from, to] of incremental) {
    for (let i = Math.max(0, from - offset); i < to - offset && i < textWidth; i++) {
      while (kinds.length <= i) kinds.push(null);
      kinds[i] = 'incsearch';
    }
  }
  for (const [from, to] of selection) {
    for (let i = Math.max(0, from - offset); i < to - offset && i < textWidth; i++) {
      while (kinds.length <= i) kinds.push(null);
      kinds[i] = 'visual';
    }
  }
  for (const column of columns) {
    const index = column - 1 - offset;
    if (index >= 0 && index < textWidth && (kinds[index] ?? null) === null) {
      while (kinds.length <= index) kinds.push(null);
      kinds[index] = 'colorcolumn';
    }
  }
  const spans: ScreenSpan[] = [];
  let i = 0;
  while (i < kinds.length) {
    const kind = kinds[i];
    if (kind === null || kind === undefined) { i++; continue; }
    let j = i + 1;
    while (j < kinds.length && kinds[j] === kind) j++;
    spans.push({ from: i, to: j, style: kind });
    i = j;
  }
  return spans;
}

const FILLER_ROW: ScreenRow = { text: '~', spans: [{ from: 0, to: 1, style: 'nontext' }] };

function windowRows(window: VimWindow, input: ScreenInput): ScreenRow[] {
  const height = window.height;
  const cols = window.cols;
  const numberColumn = window.numberColumn;
  const textWidth = window.textWidth;
  const wrapping = window.wraps;
  const spec = parseListChars(input.listchars);
  const eolMark = input.list ? spec.eol : null;
  const columns = colorColumns(input.colorcolumn, input.textwidth);
  const rows: ScreenRow[] = [];
  for (let lnum = window.top; rows.length < height && lnum < input.lines.length; lnum++) {
    const base = window.cellsOf(lnum);
    const cells: Cell[] = eolMark === null ? [...base] : [...base, { ch: eolMark, style: 'special', col: -1, first: false }];
    const picked = selectedRanges(window, input, lnum, cells);
    const selection = input.visual !== null && lnum === input.cursor.line ? withoutCursor(picked, window, input) : picked;
    const found = searchRanges(cells, input.searchSpans?.get(lnum), (input.lines[lnum] ?? '').length, base.length);
    const incremental = searchRanges(cells, input.incSearchSpans?.get(lnum), (input.lines[lnum] ?? '').length, base.length);
    const skipped = wrapping && lnum === window.top ? window.skipRows : 0;
    const chunkCount = (wrapping ? Math.max(1, Math.ceil(cells.length / textWidth)) : 1) - skipped;
    const remaining = height - rows.length;
    const drawn = Math.min(chunkCount, remaining);
    const firstRow = rows.length;
    for (let chunk = 0; chunk < drawn; chunk++) {
      const offset = wrapping ? (chunk + skipped) * textWidth : window.leftCol;
      let slice = cells.slice(offset, offset + textWidth);
      const shortLine = !wrapping && slice.length === 0 && eolMark !== null;
      if (shortLine) slice = cells.slice(-1);
      if (!wrapping) slice = trimEdges(slice, cells, offset, input.list ? spec : null);
      const spans: ScreenSpan[] = [];
      let gutter = '';
      if (numberColumn > 0) {
        gutter = chunk === 0 ? numberLabel(input, lnum, numberColumn - 1) : ' '.repeat(numberColumn);
        if (chunk === 0) spans.push({ from: 0, to: numberColumn - 1, style: lnum === input.cursor.line && input.relativenumber ? 'cursorlinenr' : 'linenr' });
      }
      const atBoundary = (ranges: readonly [number, number][]): [number, number][] => ranges.map(([from, to]): [number, number] => {
        const onEol = from === base.length && to === from + 1;
        if (onEol && shortLine) return [offset, offset + 1];
        if (onEol && eolMark === null && wrapping && from - offset === textWidth) return [from - 1, from];
        return [from, to];
      });
      for (const span of cellStyles(slice, offset, selection, atBoundary(found), atBoundary(incremental), columns, textWidth)) {
        spans.push({ ...span, from: span.from + numberColumn, to: span.to + numberColumn });
      }
      let text = gutter + rowText(slice);
      if (skipped > 0 && chunk === 0) {
        if (input.list && spec.precedes !== null) {
          text = text.slice(0, numberColumn) + spec.precedes + text.slice(numberColumn + 1);
        } else {
          const tail = text.slice(3);
          text = '<<<' + (tail.startsWith(CONTINUATION) ? ' ' + tail.slice(1) : tail);
          spans.push({ from: 0, to: 3, style: 'nontext' });
        }
      }
      if (columns.length > 0) {
        const reach = Math.max(...columns) - offset + numberColumn;
        text = padEnd(text, Math.min(cols, reach));
      }
      rows.push({ text, spans });
    }
    if (chunkCount > remaining && firstRow > 0) {
      const lastRow = rows.length - 1;
      if (input.display.includes('truncate')) {
        rows[lastRow] = { text: '@@@', spans: [{ from: 0, to: 3, style: 'nontext' }] };
      } else if (input.display.includes('lastline')) {
        const padded = padEnd(rows[lastRow].text, cols);
        const kept = Math.max(0, cols - 3);
        const shown = padded.slice(0, kept);
        const splitWide = padded[kept] === CONTINUATION && kept > 0;
        rows[lastRow] = { text: (splitWide ? shown.slice(0, -1) + ' ' : shown) + '@@@', spans: [...rows[lastRow].spans.filter((span) => span.from < kept).map((span) => ({ ...span, to: Math.min(span.to, kept) })), { from: cols - 3, to: cols, style: 'nontext' }] };
      } else {
        rows.length = firstRow;
        while (rows.length < height) rows.push({ text: '@', spans: [{ from: 0, to: 1, style: 'nontext' }] });
      }
    }
  }
  while (rows.length < height) rows.push(FILLER_ROW);
  return rows;
}

function overlay(base: string, column: number, text: string): string {
  const padded = padEnd(base, column);
  return padded.slice(0, column) + text + padded.slice(column + text.length);
}

export function rulerText(cols: number, position: string, relative: string): string | null {
  const rulerColumn = Math.max(0, cols - RULER_WIDTH);
  const thisColumn = Math.max(rulerColumn, Math.floor((cols + 1) / 2));
  let used = position.length + relative.length + 1;
  if (thisColumn + used >= cols) return position;
  let text = position;
  while (thisColumn + used < cols) {
    text += ' ';
    used++;
  }
  return text + relative;
}

export function rulerColumnOf(cols: number): number {
  return Math.max(Math.max(0, cols - RULER_WIDTH), Math.floor((cols + 1) / 2));
}

function bottomRow(window: VimWindow, input: ScreenInput, relative: string): ScreenRow {
  const cols = window.cols;
  const spans: ScreenSpan[] = [];
  if (input.commandLine) {
    return { text: input.commandLine.prompt + input.commandLine.text, spans };
  }
  let text = input.message;
  if (input.messageStyle) spans.push({ from: 0, to: cellsWidth(text), style: input.messageStyle });
  if (input.ruler) {
    const ruler = rulerText(cols, input.rulerPosition, relative);
    if (ruler !== null) text = overlay(text, rulerColumnOf(cols), ruler);
  }
  if (input.showcmd !== null && input.showcmd !== '') {
    const column = Math.max(1, cols - (input.ruler ? RULER_WIDTH : 0) - SHOWCMD_WIDTH - (input.ruler ? 0 : 1));
    text = overlay(text, column, input.showcmd.slice(-SHOWCMD_WIDTH));
  }
  return { text, spans };
}

export function relativeLabel(position: 'All' | 'Top' | 'Bot' | number): string {
  return typeof position === 'number' ? `${padToWidth(String(position), 2, 'right')}%` : position;
}

export function buildScreen(window: VimWindow, input: ScreenInput): EditorScreen {
  const rows = windowRows(window, input);
  rows.push(bottomRow(window, input, relativeLabel(window.relativePosition())));
  const shown = input.cursorAt ?? input.cursor;
  const cursor = input.commandLine
    ? { row: window.height, col: Math.min(window.cols - 1, cellsWidth(input.commandLine.prompt + input.commandLine.text)) }
    : window.cursorCell(shown.line, shown.col, input.cursorAt === null ? input.tabEnd : false);
  return { rows, cursor };
}

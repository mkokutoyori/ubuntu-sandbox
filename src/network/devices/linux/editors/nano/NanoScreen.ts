import type { EditorScreen, ScreenBand, ScreenRow, ScreenSpan } from '../screen/EditorScreen';
import { CONTINUATION } from '../screen/EditorScreen';
import { actualX, advanceOver, breadth, DEFAULT_TABSIZE, displayString, wideness, type DisplayResult } from './NanoText';
import { NANO_MENUS, type NanoMenuName } from './NanoMenus';
import type { NanoWindow, Position } from './NanoWindow';

export type TitleState = 'View' | 'Modified' | '';

export interface TitleStateFlags {
  readonly letters: string;
  readonly modified: boolean;
}

const STATE_FLAGS_PLACEHOLDER = '+.xxxxx';
const DOTTED_NAME_START = 5;

export interface MinibarInfo {
  readonly name: string;
  readonly modified: boolean;
  readonly line: number;
  readonly column: number;
  readonly lineCount: number | null;
  readonly showPosition: boolean;
  readonly hex: string;
  readonly stateLetters: string | null;
  readonly percent: number;
}

export interface NanoScreenInput {
  readonly window: NanoWindow;
  readonly lines: readonly string[];
  readonly cursor: Position;
  readonly mark: Position | null;
  readonly spotlight: { readonly line: number; readonly start: number; readonly end: number } | null;
  readonly tabsize: number;
  readonly softwrap: boolean;
  readonly title: { readonly name: string; readonly state: TitleState; readonly branding: string; readonly flags: TitleStateFlags | null };
  readonly status: { readonly text: string; readonly alert: boolean; readonly more?: boolean; readonly raw?: boolean } | null;
  readonly minibar: MinibarInfo | null;
  readonly prompt: { readonly label: string; readonly answer: string; readonly cursor: number } | null;
  readonly yesNo: { readonly question: string; readonly withAll: boolean } | null;
  readonly menu: NanoMenuName;
  readonly helpLines: readonly string[] | null;
}

class Canvas {
  readonly cells: string[];
  readonly spans: ScreenSpan[] = [];

  constructor(readonly width: number) {
    this.cells = new Array(width).fill(' ');
  }

  put(column: number, text: string): number {
    let at = column;
    for (const ch of text) {
      if (at >= this.width) break;
      const span = advanceOver(ch, 0, at, DEFAULT_TABSIZE).width;
      if (at >= 0) this.cells[at] = ch;
      if (span === 2 && at + 1 >= 0 && at + 1 < this.width) this.cells[at + 1] = CONTINUATION;
      at += span;
    }
    return at;
  }

  putCells(column: number, cells: readonly string[]): void {
    for (let i = 0; i < cells.length && column + i < this.width; i++) this.cells[column + i] = cells[i] === '' ? CONTINUATION : cells[i];
  }

  mark(from: number, to: number, style: ScreenSpan['style']): void {
    if (to > from) this.spans.push({ from, to: Math.min(to, this.width), style });
  }

  row(): ScreenRow {
    return { text: this.cells.join('').replace(/ +$/, ''), spans: this.spans };
  }

  fullRow(): ScreenRow {
    return { text: this.cells.join(''), spans: this.spans };
  }
}

const SPACE_ROW: ScreenRow = { text: '', spans: [] };

function clipped(text: string, width: number, tabsize: number): string {
  const end = actualX(text, width, tabsize);
  return text.slice(0, end);
}

export function titleRow(cols: number, name: string, state: TitleState, branding: string, tabsize: number, flags: TitleStateFlags | null = null): ScreenRow {
  const canvas = new Canvas(cols);
  const flagged = flags !== null && state !== 'View';
  const stateWord = flagged ? STATE_FLAGS_PLACEHOLDER : state;
  let upperleft = branding;
  let verlen = breadth(upperleft, tabsize) + 3;
  let pluglen = 0;
  if (stateWord === '') pluglen = breadth('Modified', tabsize) + 1;
  let statelen = breadth(stateWord, tabsize) + 2;
  let pathlen = breadth(name, tabsize);
  if (statelen > 2) pathlen++;

  if (verlen + pathlen + pluglen + statelen <= cols) {
    canvas.put(2, upperleft);
  } else {
    upperleft = '';
    verlen = 2;
    if (verlen + pathlen + pluglen + statelen > cols) pluglen = 0;
    if (verlen + pathlen + pluglen + statelen > cols) {
      verlen = 0;
      statelen -= 2;
    }
  }

  let offset = 0;
  if (verlen > 0) offset = verlen + Math.floor((cols - (verlen + pluglen + statelen) - pathlen) / 2);

  let afterPath = offset;
  if (pathlen + pluglen + statelen <= cols) {
    const caption = displayString(name, 0, pathlen, { isData: false, isPrompt: false, softwrap: false, tabsize });
    canvas.putCells(offset, caption.cells);
    afterPath = offset + caption.cells.length;
  } else if (5 + statelen <= cols) {
    canvas.put(offset, '...');
    const caption = displayString(name, 3 + pathlen - cols + statelen, cols - statelen, { isData: false, isPrompt: false, softwrap: false, tabsize });
    canvas.putCells(offset + 3, caption.cells);
    afterPath = offset + 3 + caption.cells.length;
  }

  if (flagged && flags !== null) {
    if (flags.modified && cols > 1) canvas.put(afterPath, ' *');
    if (statelen < cols) canvas.put(cols + 2 - statelen, flags.letters);
  } else if (statelen > 0 && statelen <= cols) canvas.put(cols - statelen, state);
  else if (statelen > 0) canvas.put(0, clipped(state, cols, tabsize));

  canvas.mark(0, cols, 'reverse');
  return canvas.fullRow();
}

function numberLabel(line: number, width: number): string {
  return String(line + 1).padStart(width);
}

function selectionBounds(input: NanoScreenInput): { top: Position; bottom: Position } | null {
  const mark = input.mark;
  if (mark === null) return null;
  const cursor = input.cursor;
  const markFirst = mark.line < cursor.line || (mark.line === cursor.line && mark.col <= cursor.col);
  return markFirst ? { top: mark, bottom: cursor } : { top: cursor, bottom: mark };
}

function drawDataRow(
  input: NanoScreenInput, lineIndex: number, fromCol: number, display: DisplayResult, firstChunk: boolean,
  sidescrolled: boolean, spanEnd: number,
): ScreenRow {
  const window = input.window;
  const margin = window.margin;
  const canvas = new Canvas(window.cols);
  if (margin > 0) {
    const label = input.softwrap && !firstChunk ? ' '.repeat(margin - 1) : numberLabel(lineIndex, margin - 1);
    canvas.put(0, label);
    canvas.mark(0, margin - 1, 'reverse');
  }
  canvas.putCells(margin, display.cells);
  const text = input.lines[lineIndex] ?? '';
  const bounds = selectionBounds(input);
  if (bounds !== null && lineIndex >= bounds.top.line && lineIndex <= bounds.bottom.line) {
    let topX = bounds.top.col;
    let bottomX = bounds.bottom.col;
    if (bounds.top.line < lineIndex || topX < display.fromX) topX = display.fromX;
    if (bounds.bottom.line > lineIndex || bottomX > display.tillX) bottomX = display.tillX;
    if (topX < display.tillX && bottomX > display.fromX) {
      let start = wideness(text, topX, input.tabsize) - fromCol;
      if (start < 0) start = 0;
      let end = display.cells.length;
      if (bottomX < display.tillX) end = Math.min(end, wideness(text, bottomX, input.tabsize) - fromCol);
      canvas.mark(margin + start, margin + Math.max(start, end), 'reverse');
    }
  }
  const light = input.spotlight;
  let spotlit: { column: number; cells: readonly string[] } | null = null;
  if (light !== null && light.line === lineIndex) {
    const from = Math.max(light.start, display.fromX);
    const to = Math.min(light.end, display.tillX);
    if (to > from) {
      const start = Math.max(0, wideness(text, from, input.tabsize) - fromCol);
      const end = Math.max(0, wideness(text, to, input.tabsize) - fromCol);
      const word = displayString(text, wideness(text, from, input.tabsize), wideness(text, to, input.tabsize) - wideness(text, from, input.tabsize), {
        isData: false, isPrompt: false, softwrap: false, tabsize: input.tabsize,
      });
      spotlit = { column: margin + start, cells: word.cells.slice(0, Math.max(0, window.cols - margin - start)) };
      canvas.mark(margin + start, margin + end, 'reverse');
    }
  }
  if (sidescrolled && fromCol > 0 && display.cells.length > 0) {
    canvas.put(margin, '<');
    canvas.mark(margin, margin + 1, 'reverse');
  }
  if (display.hasMore) {
    canvas.put(window.cols - 1, '>');
    canvas.mark(window.cols - 1, window.cols, 'reverse');
  }
  if (spotlit !== null) canvas.putCells(spotlit.column, spotlit.cells);
  void spanEnd;
  return canvas.row();
}

function editRows(input: NanoScreenInput): ScreenRow[] {
  const window = input.window;
  const rows: ScreenRow[] = [];
  const height = window.editRows;
  const tabsize = input.tabsize;
  for (let line = window.edittop; rows.length < height && line < input.lines.length; line++) {
    const text = input.lines[line];
    if (!input.softwrap) {
      const isCurrent = line === input.cursor.line;
      const fromCol = isCurrent ? window.pageStart(wideness(text, input.cursor.col, tabsize)) : 0;
      const display = displayString(text, fromCol, window.editCols, { isData: true, isPrompt: false, softwrap: false, tabsize });
      rows.push(drawDataRow(input, line, fromCol, display, true, true, window.editCols));
      continue;
    }
    let fromCol = line === window.edittop ? window.firstcolumn : 0;
    for (;;) {
      const { end, endOfLine } = window.breakpoint(text, fromCol);
      const display = displayString(text, fromCol, end - fromCol, { isData: true, isPrompt: false, softwrap: true, tabsize });
      rows.push(drawDataRow(input, line, fromCol, display, fromCol === 0, false, end));
      if (endOfLine || rows.length >= height) break;
      fromCol = end;
    }
  }
  while (rows.length < height) rows.push(SPACE_ROW);
  return rows;
}

function helpRows(input: NanoScreenInput): ScreenRow[] {
  const height = input.window.editRows;
  const rows: ScreenRow[] = [];
  for (const line of input.helpLines ?? []) {
    if (rows.length >= height) break;
    const shown = displayString(line, 0, input.window.cols, { isData: false, isPrompt: false, softwrap: false, tabsize: input.tabsize });
    const canvas = new Canvas(input.window.cols);
    canvas.putCells(0, shown.cells);
    rows.push(canvas.row());
  }
  while (rows.length < height) rows.push(SPACE_ROW);
  return rows;
}

function statusRow(cols: number, status: { text: string; alert: boolean; more?: boolean; raw?: boolean } | null, tabsize: number): ScreenRow {
  if (status === null) return SPACE_ROW;
  if (status.raw === true) {
    const left = new Canvas(cols);
    left.put(0, clipped(status.text, cols - 1, tabsize));
    left.mark(0, cols, 'reverse');
    return left.fullRow();
  }
  const canvas = new Canvas(cols);
  const message = displayString(status.text, 0, cols, { isData: false, isPrompt: false, softwrap: false, tabsize }).cells;
  const width = message.length;
  const start = Math.floor((cols - width) / 2);
  const bracketed = start > 1;
  const left = bracketed ? start - 2 : start;
  let at = left;
  const style = status.alert ? 'alert' : 'reverse';
  if (bracketed) canvas.put(at, '[ ');
  if (bracketed) at += 2;
  canvas.putCells(at, message);
  at += width;
  if (bracketed) {
    canvas.put(at, ' ]');
    at += 2;
  }
  canvas.mark(left, at, style);
  const dotsAt = cols + 2 - start;
  if (status.more === true && start > 4 && dotsAt + 3 <= cols) {
    canvas.put(dotsAt, '...');
    canvas.mark(dotsAt, dotsAt + 3, style);
  }
  return canvas.row();
}

export function minibarRow(cols: number, info: MinibarInfo, tabsize: number): ScreenRow {
  const canvas = new Canvas(cols);
  const options = { isData: false, isPrompt: false, softwrap: false, tabsize };
  const namewidth = breadth(info.name, tabsize);
  const padding = namewidth + 19 > cols ? 0 : 2;
  let at = 0;
  if (cols > 4) {
    at = padding;
    if (namewidth > cols - 2) {
      canvas.put(at, '...');
      at += 3;
      const shown = displayString(info.name, DOTTED_NAME_START, cols - 5, options);
      canvas.putCells(at, shown.cells);
      at += shown.cells.length;
    } else {
      const shown = displayString(info.name, 0, cols - 2, options);
      canvas.putCells(at, shown.cells);
      at += shown.cells.length;
    }
    canvas.put(at, info.modified ? ' *' : '  ');
    at += 2;
  }
  const location = `${info.line},${info.column}`;
  let tallywidth = 0;
  if (info.lineCount !== null && cols > 35) {
    const tally = ` (${info.lineCount} line${info.lineCount === 1 ? '' : 's'})`;
    tallywidth = breadth(tally, tabsize);
    if (namewidth + tallywidth + 11 < cols) canvas.put(at, tally);
    else tallywidth = 0;
  }
  if (info.showPosition && namewidth + tallywidth + location.length + 32 < cols) canvas.put(cols - 27 - location.length, location);
  if (info.showPosition && namewidth + tallywidth + 28 < cols) canvas.put(cols - 23, info.hex);
  if (info.stateLetters !== null && namewidth + tallywidth + 14 + 2 * padding < cols) canvas.put(cols - 11 - padding, info.stateLetters);
  if (namewidth + 6 < cols) canvas.put(cols - 4 - padding, `${String(info.percent).padStart(3)}%`);
  canvas.mark(0, cols, 'reverse');
  return canvas.fullRow();
}

function promptPageStart(base: number, column: number, cols: number): number {
  if (column === base || column < cols - 1) return 0;
  if (cols > base + 2) return column - base - 1 - ((column - base - 1) % (cols - base - 2));
  return column - 2;
}

interface PromptView {
  readonly row: ScreenRow;
  readonly cursorColumn: number;
}

function promptRow(cols: number, label: string, answer: string, answerCursor: number, tabsize: number): PromptView {
  const canvas = new Canvas(cols);
  const prompt = clipped(label, cols < 5 ? 0 : cols - 5, tabsize);
  const base = breadth(prompt, tabsize) + 2;
  const column = base + wideness(answer, answerCursor, tabsize);
  const page = promptPageStart(base, column, cols);
  const endPage = promptPageStart(base, base + breadth(answer, tabsize) - 1, cols);
  canvas.put(0, `${prompt}:`);
  canvas.put(breadth(prompt, tabsize) + 1, page === 0 ? ' ' : '<');
  const shown = displayString(answer, page, cols - base, { isData: false, isPrompt: true, softwrap: false, tabsize });
  canvas.putCells(base, shown.cells);
  if (page < endPage && base + breadth(answer, tabsize) - page > cols) canvas.put(cols - 1, '>');
  canvas.mark(0, cols, 'reverse');
  return { row: canvas.fullRow(), cursorColumn: column - page };
}

function postOneKey(canvas: Canvas, at: number, key: string, tag: string, width: number, tabsize: number): void {
  const keyText = clipped(key, width, tabsize);
  canvas.put(at, keyText);
  canvas.mark(at, at + breadth(keyText, tabsize), 'reverse');
  let remaining = width - breadth(key, tabsize);
  if (remaining < 2) return;
  canvas.put(at + breadth(key, tabsize), ' ');
  remaining -= 1;
  canvas.put(at + breadth(key, tabsize) + 1, clipped(tag, remaining, tabsize));
}

function shortcutRows(cols: number, menu: NanoMenuName, tabsize: number): [ScreenRow, ScreenRow] {
  const entries = NANO_MENUS[menu];
  const maximum = Math.floor((cols + 40) / 20) * 2;
  const number = Math.min(entries.length, maximum);
  const itemwidth = Math.floor(cols / Math.floor((number + 1) / 2));
  const canvases = [new Canvas(cols), new Canvas(cols)];
  if (itemwidth === 0) return [SPACE_ROW, SPACE_ROW];
  for (let index = 0; index < number; index++) {
    let width = itemwidth;
    if (number % 2 === 1 && index + 2 === number) width += itemwidth;
    if (index + 2 >= number) width += cols % itemwidth;
    const entry = entries[index];
    postOneKey(canvases[index % 2], Math.floor(index / 2) * itemwidth, entry.key, entry.tag, width, tabsize);
  }
  return [canvases[0].row(), canvases[1].row()];
}

function yesNoRows(cols: number, withAll: boolean, tabsize: number): [ScreenRow, ScreenRow] {
  const width = cols < 32 ? Math.floor(cols / 2) : 16;
  const first = new Canvas(cols);
  const second = new Canvas(cols);
  postOneKey(first, 0, ' Y', 'Yes', width, tabsize);
  postOneKey(second, 0, ' N', 'No', width, tabsize);
  if (withAll) postOneKey(first, width, ' A', 'All', width, tabsize);
  postOneKey(second, width, '^C', 'Cancel', width, tabsize);
  return [first.row(), second.row()];
}

export function buildNanoScreen(input: NanoScreenInput): EditorScreen {
  const window = input.window;
  const cols = window.cols;
  const tabsize = input.tabsize;
  const layout = window.layout;
  const rows: ScreenRow[] = new Array(window.rows).fill(SPACE_ROW);
  let cursorAt: { row: number; col: number } | null = null;

  if (layout.titleRows > 0) rows[0] = titleRow(cols, input.title.name, input.title.state, input.title.branding, tabsize, input.title.flags);

  const body = input.helpLines === null ? editRows(input) : helpRows(input);
  const bodyTop = layout.editFrom;
  body.forEach((row, index) => { if (bodyTop + index < rows.length) rows[bodyTop + index] = row; });

  let footerStatus: ScreenRow;
  let bars: [ScreenRow, ScreenRow] | null = null;
  if (input.yesNo !== null) {
    const question = clipped(input.yesNo.question, cols - 1, tabsize);
    const canvas = new Canvas(cols);
    canvas.put(0, question);
    canvas.mark(0, cols, 'reverse');
    footerStatus = canvas.fullRow();
    bars = yesNoRows(cols, input.yesNo.withAll, tabsize);
    cursorAt = { row: -1, col: Math.min(breadth(input.yesNo.question, tabsize), cols - 1) };
  } else if (input.prompt !== null) {
    const view = promptRow(cols, input.prompt.label, input.prompt.answer, input.prompt.cursor, tabsize);
    footerStatus = view.row;
    bars = shortcutRows(cols, input.menu, tabsize);
    cursorAt = { row: -1, col: view.cursorColumn };
  } else {
    footerStatus = input.minibar !== null ? minibarRow(cols, input.minibar, tabsize) : statusRow(cols, input.status, tabsize);
    bars = shortcutRows(cols, input.menu, tabsize);
    if (input.helpLines === null) {
      const place = window.place(input.cursor);
      cursorAt = { row: bodyTop + place.row, col: window.margin + place.column };
    }
  }

  const footerHasContent = input.yesNo !== null || input.prompt !== null || input.status !== null || input.minibar !== null;
  if (layout.statusRow >= layout.editFrom + layout.editRows || footerHasContent) rows[layout.statusRow] = footerStatus;
  if (layout.barsFrom !== null && bars !== null) {
    rows[layout.barsFrom] = bars[0];
    rows[layout.barsFrom + 1] = bars[1];
  }

  if (cursorAt !== null && cursorAt.row === -1) cursorAt = { row: layout.statusRow, col: cursorAt.col };
  const bands: ScreenBand[] = [];
  if (layout.titleRows > 0) bands.push({ name: 'title', from: 0, to: layout.titleRows });
  bands.push({ name: 'edit', from: layout.editFrom, to: layout.editFrom + layout.editRows });
  bands.push({ name: 'status', from: layout.statusRow, to: layout.statusRow + 1 });
  if (layout.barsFrom !== null) bands.push({ name: 'bars', from: layout.barsFrom, to: layout.barsFrom + 2 });
  return { rows, cursor: cursorAt, bands };
}

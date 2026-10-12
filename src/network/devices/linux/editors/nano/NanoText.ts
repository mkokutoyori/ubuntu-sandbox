import { codePointWidth } from '../vim/VimCells';

export const DEFAULT_TABSIZE = 8;

const DELETE = 0x7f;

export interface Advance {
  readonly length: number;
  readonly width: number;
}

function isControl(code: number): boolean {
  return code < 0x20 || code === DELETE || (code >= 0x80 && code < 0xa0);
}

export function controlRepresentation(code: number): string {
  if (code === DELETE) return '?';
  if (code >= 0x80 && code < 0xa0) return String.fromCharCode(code - 0x80 + 0x40);
  return String.fromCharCode(code + 0x40);
}

function glyphWidth(code: number): number {
  const width = codePointWidth(code);
  return width >= 4 ? 1 : width;
}

export function advanceOver(text: string, index: number, column: number, tabsize: number): Advance {
  const code = text.codePointAt(index)!;
  const length = code > 0xffff ? 2 : 1;
  if (code === 0x09) return { length, width: tabsize - (column % tabsize) };
  if (isControl(code)) return { length, width: 2 };
  return { length, width: glyphWidth(code) };
}

export function wideness(text: string, count: number, tabsize: number): number {
  let width = 0;
  let index = 0;
  while (index < text.length && index < count) {
    const step = advanceOver(text, index, width, tabsize);
    width += step.width;
    index += step.length;
  }
  return width;
}

export function breadth(text: string, tabsize: number): number {
  return wideness(text, text.length, tabsize);
}

export function actualX(text: string, column: number, tabsize: number): number {
  let width = 0;
  let index = 0;
  while (index < text.length) {
    const step = advanceOver(text, index, width, tabsize);
    if (width + step.width > column) break;
    width += step.width;
    index += step.length;
  }
  return index;
}

export interface DisplayResult {
  readonly cells: readonly string[];
  readonly hasMore: boolean;
  readonly isShorter: boolean;
  readonly fromX: number;
  readonly tillX: number;
}

export interface DisplayOptions {
  readonly isData: boolean;
  readonly isPrompt: boolean;
  readonly softwrap: boolean;
  readonly tabsize: number;
}

function pushGlyph(cells: string[], glyph: string, width: number): void {
  if (width === 0) {
    if (cells.length > 0) cells[cells.length - 1] += glyph;
    else cells.push(glyph);
    return;
  }
  cells.push(glyph);
  for (let i = 1; i < width; i++) cells.push('');
}

export function displayString(text: string, column: number, span: number, options: DisplayOptions): DisplayResult {
  const { isData, isPrompt, softwrap, tabsize } = options;
  const startX = actualX(text, column, tabsize);
  const startCol = wideness(text, startX, tabsize);
  const beyond = column + span;
  const cells: string[] = [];
  let index = startX;
  let col = column;

  const leading = (startCol < column || (startCol > 0 && isData && !softwrap)) && index < text.length && text[index] !== '\t';
  if (leading) {
    const code = text.codePointAt(index)!;
    const length = code > 0xffff ? 2 : 1;
    if (isControl(code)) {
      if (startCol < column) {
        cells.push(controlRepresentation(code));
        col++;
        index += length;
      }
    } else if (glyphWidth(code) === 2) {
      if (startCol === column) {
        cells.push(' ');
        col++;
      }
      cells.push(']');
      col++;
      index += length;
    }
  }

  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const length = code > 0xffff ? 2 : 1;
    const width = isControl(code) || code === 0x09 ? 1 : glyphWidth(code);
    const zeroWidth = !isControl(code) && code !== 0x09 && width === 0;
    if (!(col < beyond || zeroWidth)) break;
    if (code === 0x09) {
      cells.push(' ');
      col++;
      while (col % tabsize !== 0 && col < beyond) {
        cells.push(' ');
        col++;
      }
      index += length;
      continue;
    }
    if (isControl(code)) {
      cells.push('^', controlRepresentation(code));
      col += 2;
      index += length;
      continue;
    }
    pushGlyph(cells, String.fromCodePoint(code), width);
    col += width;
    index += length;
  }

  let hasMore = false;
  if (col > beyond || (index < text.length && (isPrompt || (isData && !softwrap)))) {
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) {
      const last = cells.pop()!;
      if (codePointWidth(last.codePointAt(0)!) === 2) cells.push('[');
    }
    hasMore = true;
  }

  return { cells, hasMore, isShorter: col < beyond, fromX: startX, tillX: index };
}

export function leadingBytes(text: string, byteLimit: number): string {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index)!;
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes >= byteLimit) break;
    bytes += size;
    index += code > 0xffff ? 2 : 1;
  }
  return text.slice(0, index);
}

function parseNumber(text: string): number | null {
  const match = /^[+-]?\d+$/.exec(text);
  if (match === null) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseLineAndColumn(input: string): { line: number; column: number } | null {
  const text = input.replace(/^ +/, '');
  const separator = /[m,. /;]/.exec(text);
  if (separator === null) {
    const line = parseNumber(text);
    return line === null ? null : { line, column: 0 };
  }
  let line = 0;
  if (separator.index > 0) {
    const first = parseNumber(text.slice(0, separator.index));
    if (first === null) return null;
    line = first;
  }
  const rest = text.slice(separator.index + 1).replace(/^ +/, '');
  if (rest === '') return null;
  const column = parseNumber(rest);
  return column === null ? null : { line, column };
}

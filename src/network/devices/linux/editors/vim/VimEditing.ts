import { charCells, cursorVcol, isWhite, type Pos } from './VimCursor';

export interface RegisterText {
  linewise: boolean;
  lines: string[];
}

export function removeChars(lines: string[], start: Pos, end: Pos): string[] {
  if (start.line === end.line) {
    const text = lines[start.line] ?? '';
    const removed = text.slice(start.col, end.col);
    lines[start.line] = text.slice(0, start.col) + text.slice(end.col);
    return [removed];
  }
  const first = lines[start.line] ?? '';
  const last = lines[end.line] ?? '';
  const removed: string[] = [first.slice(start.col)];
  for (let i = start.line + 1; i < end.line; i++) removed.push(lines[i] ?? '');
  removed.push(last.slice(0, end.col));
  lines.splice(start.line, end.line - start.line + 1, first.slice(0, start.col) + last.slice(end.col));
  return removed;
}

export function sliceChars(lines: readonly string[], start: Pos, end: Pos): string[] {
  if (start.line === end.line) return [(lines[start.line] ?? '').slice(start.col, end.col)];
  const out: string[] = [(lines[start.line] ?? '').slice(start.col)];
  for (let i = start.line + 1; i < end.line; i++) out.push(lines[i] ?? '');
  out.push((lines[end.line] ?? '').slice(0, end.col));
  return out;
}

export function indentWidth(line: string, tabstop: number): { width: number; chars: number } {
  let width = 0;
  let chars = 0;
  while (chars < line.length && isWhite(line[chars])) {
    width += line[chars] === '\t' ? tabstop - (width % tabstop) : 1;
    chars++;
  }
  return { width, chars };
}

export function indentString(width: number, tabstop: number, expandtab = false): string {
  if (expandtab) return ' '.repeat(width);
  return '\t'.repeat(Math.floor(width / tabstop)) + ' '.repeat(width % tabstop);
}

function backspaceClass(ch: string): number {
  if (ch === ' ' || ch === '\t') return 0;
  const code = ch.codePointAt(0)!;
  if (code < 0x80) return /[A-Za-z0-9_]/.test(ch) ? 2 : 1;
  if (code >= 0x4e00 && code <= 0x9fff) return 0x4e00;
  if (code >= 0x3040 && code <= 0x30ff) return 0x3040;
  if (code >= 0xac00 && code <= 0xd7a3) return 0xac00;
  return code >= 0xc0 ? 2 : 1;
}

export function backspaceTarget(line: string, col: number, floor: number, stopAt: number, word: boolean): number {
  let cur = col;
  let inRun = false;
  let runClass = 0;
  for (;;) {
    cur--;
    const cls = backspaceClass(line[cur]);
    if (word) {
      if (!inRun) {
        if (cls !== 0) { inRun = true; runClass = cls; }
      } else if (cls === 0 || cls !== runClass) {
        cur++;
        break;
      }
    }
    if (!(cur > floor && cur !== stopAt)) break;
  }
  return cur;
}

export function roundedIndent(width: number, shiftwidth: number, left: boolean): number {
  const remainder = width % shiftwidth;
  let units = Math.floor(width / shiftwidth);
  if (left) {
    if (remainder === 0) units -= 1;
  } else {
    units += 1;
  }
  return Math.max(0, units) * shiftwidth;
}

export function reindentLine(line: string, col: number, tabstop: number, indent: number, expandtab: boolean): LineEdit {
  const old = indentWidth(line, tabstop);
  const lead = indentString(indent, tabstop, expandtab);
  const next = lead + line.slice(old.chars);
  if (col >= old.chars) return { line: next, col: col - old.chars + lead.length };
  let before = 0;
  for (let i = 0; i < col; i++) before += line[i] === '\t' ? tabstop - (before % tabstop) : 1;
  const target = Math.max(0, indent - (old.width - before));
  let newCol = 0;
  let width = 0;
  while (newCol < lead.length) {
    const advance = lead[newCol] === '\t' ? tabstop - (width % tabstop) : 1;
    if (width + advance > target) break;
    width += advance;
    newCol++;
  }
  const padding = ' '.repeat(target - width);
  return { line: lead.slice(0, newCol) + padding + lead.slice(newCol) + line.slice(old.chars), col: newCol + padding.length };
}

export function shiftLine(line: string, tabstop: number, shiftwidth: number, amount: number, expandtab = false): string {
  if (line.length === 0) return line;
  const { width, chars } = indentWidth(line, tabstop);
  const rounded = width + amount * shiftwidth;
  return indentString(Math.max(0, rounded), tabstop, expandtab) + line.slice(chars);
}

export interface TabSettings {
  readonly tabstop: number;
  readonly ctrlTab?: boolean;
  readonly softtabstop: number;
  readonly expandtab: boolean;
}

export interface LineEdit {
  readonly line: string;
  readonly col: number;
}

export function tabSpaces(line: string, col: number, settings: TabSettings): number {
  const step = settings.softtabstop > 0 ? settings.softtabstop : settings.tabstop;
  return step - (cursorVcol(line, col, settings.tabstop, false, settings.ctrlTab) % step);
}

export interface TabEdit extends LineEdit {
  readonly from: number;
}

export function insertTab(line: string, col: number, settings: TabSettings, replacing: { readonly floor: number } | null = null): TabEdit {
  if (!settings.expandtab && settings.softtabstop === 0) {
    return { line: line.slice(0, col) + '\t' + line.slice(col), col: col + 1, from: col };
  }
  const spaces = tabSpaces(line, col, settings);
  const overwritten = replacing !== null && col < line.length ? 1 : 0;
  const widened = line.slice(0, col) + ' '.repeat(spaces) + line.slice(col + overwritten);
  const cursor = col + spaces;
  if (settings.expandtab) return { line: widened, col: cursor, from: col };
  let first = cursor;
  const floor = replacing === null ? 0 : replacing.floor;
  while (first > floor && isWhite(widened[first - 1])) first--;
  const want = cursorVcol(widened, cursor, settings.tabstop, false, settings.ctrlTab);
  const chars = widened.split('');
  let at = first;
  let vcol = cursorVcol(widened, first, settings.tabstop, false, settings.ctrlTab);
  let changed = -1;
  while (at < chars.length && isWhite(chars[at])) {
    const width = charCells('\t', vcol, settings.tabstop, settings.ctrlTab);
    if (vcol + width > want) break;
    if (chars[at] !== '\t') {
      chars[at] = '\t';
      if (changed < 0) changed = at;
    }
    at++;
    vcol += width;
  }
  if (changed < 0) return { line: widened, col: cursor, from: col };
  while (at < chars.length && isWhite(chars[at])) {
    const width = charCells(chars[at], vcol, settings.tabstop, settings.ctrlTab);
    if (vcol + width > want) break;
    at++;
    vcol += width;
  }
  const removed = Math.max(0, cursor - at);
  chars.splice(at, removed);
  return { line: chars.join(''), col: cursor - removed, from: Math.min(changed, col) };
}

export function softBackspace(line: string, col: number, settings: TabSettings, typedSpace: boolean): LineEdit | null {
  if (settings.softtabstop === 0 || col === 0) return null;
  const previous = line[col - 1];
  if (!(previous === '\t' || (previous === ' ' && !typedSpace))) return null;
  const previousStart = cursorVcol(line, col - 1, settings.tabstop, false, settings.ctrlTab);
  const previousEnd = previousStart + charCells(previous, previousStart, settings.tabstop, settings.ctrlTab) - 1;
  const want = Math.floor(previousEnd / settings.softtabstop) * settings.softtabstop;
  let text = line;
  let at = col;
  let vcol = cursorVcol(text, at, settings.tabstop, false, settings.ctrlTab);
  while (vcol > want && at > 0 && isWhite(text[at - 1])) {
    text = text.slice(0, at - 1) + text.slice(at);
    at--;
    vcol = cursorVcol(text, at, settings.tabstop, false, settings.ctrlTab);
  }
  while (vcol < want) {
    text = text.slice(0, at) + ' ' + text.slice(at);
    at++;
    vcol = cursorVcol(text, at, settings.tabstop, false, settings.ctrlTab);
  }
  return { line: text, col: at };
}

function singleCharacterCase(character: string, converted: string): string {
  const [first, ...rest] = [...converted];
  return rest.every((extra) => /\p{M}/u.test(extra)) ? first : character;
}

export function upperCaseChar(character: string): string {
  return singleCharacterCase(character, character.toUpperCase());
}

export function lowerCaseChar(character: string): string {
  return singleCharacterCase(character, character.toLowerCase());
}

export function swapCase(ch: string): string {
  const up = ch.toUpperCase();
  const low = ch.toLowerCase();
  if (ch === up && ch !== low) return low;
  if (ch === low && ch !== up) return up;
  return ch;
}

export interface JoinOutcome {
  readonly line: string;
  readonly col: number;
}

export function joinText(parts: readonly string[], insertSpace: boolean, joinSpaces: boolean): JoinOutcome {
  let result = parts[0] ?? '';
  let sumsize = result.length;
  let endcurr1 = result.length > 0 ? result[result.length - 1] : '';
  let endcurr2 = result.length > 1 ? result[result.length - 2] : '';
  let lastSpaces = 0;
  let lastSize = result.length;
  for (let t = 1; t < parts.length; t++) {
    let curr = parts[t];
    let spaces = 0;
    if (insertSpace) {
      curr = curr.replace(/^[ \t]+/, '');
      if (curr.length > 0 && curr[0] !== ')' && sumsize !== 0 && endcurr1 !== '\t') {
        if (endcurr1 === ' ') endcurr1 = endcurr2;
        else spaces++;
        if (joinSpaces && (endcurr1 === '.' || endcurr1 === '?' || endcurr1 === '!')) spaces++;
      }
    }
    result += ' '.repeat(spaces) + curr;
    sumsize += curr.length + spaces;
    lastSpaces = spaces;
    lastSize = curr.length;
    endcurr1 = '';
    endcurr2 = '';
    if (insertSpace && curr.length > 0) {
      endcurr1 = curr[curr.length - 1];
      if (curr.length > 1) endcurr2 = curr[curr.length - 2];
    }
  }
  const col = sumsize - lastSize - lastSpaces;
  return { line: result, col: Math.max(0, col) };
}

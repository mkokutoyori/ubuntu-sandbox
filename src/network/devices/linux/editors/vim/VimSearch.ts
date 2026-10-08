import { isWhite, type Pos } from './VimCursor';
import { compileVimPattern } from './VimPattern';

export type OffsetKind = 'none' | 'line' | 'end' | 'start';

export interface SearchOffset {
  readonly kind: OffsetKind;
  readonly amount: number;
}

export interface ParsedSearch {
  readonly pattern: string;
  readonly offset: SearchOffset;
  readonly chained: string | null;
}

export interface LastSearch {
  readonly pattern: string;
  readonly forward: boolean;
  readonly offset: SearchOffset;
}

export interface MatchResult {
  readonly start: Pos;
  readonly end: Pos;
  readonly wrapped: boolean;
}

export interface SearchTarget {
  readonly pos: Pos;
  readonly linewise: boolean;
  readonly inclusive: boolean;
  readonly wrapped: boolean;
  readonly match: MatchResult;
}

export const NO_OFFSET: SearchOffset = { kind: 'none', amount: 0 };

function parseOffset(text: string): SearchOffset {
  const match = /^([esb]?)([+-]?)(\d*)$/.exec(text);
  if (!match || text === '') return NO_OFFSET;
  const [, letter, sign, digits] = match;
  const magnitude = digits === '' ? (sign === '' ? 0 : 1) : parseInt(digits, 10);
  const amount = sign === '-' ? -magnitude : magnitude;
  if (letter === 'e') return { kind: 'end', amount };
  if (letter === 's' || letter === 'b') return { kind: 'start', amount };
  return { kind: 'line', amount };
}

export function parseSearchInput(input: string, delimiter: '/' | '?'): ParsedSearch {
  let pattern = '';
  let i = 0;
  for (; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && i + 1 < input.length) {
      pattern += c + input[i + 1];
      i++;
      continue;
    }
    if (c === delimiter) break;
    pattern += c;
  }
  const rest = i < input.length ? input.slice(i + 1) : '';
  const semicolon = rest.indexOf(';');
  if (semicolon >= 0) {
    return { pattern, offset: parseOffset(rest.slice(0, semicolon)), chained: rest.slice(semicolon + 1) };
  }
  return { pattern, offset: parseOffset(rest), chained: null };
}

interface Located {
  readonly index: number;
  readonly length: number;
}

function lineStarts(lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  return starts;
}

function offsetOf(starts: readonly number[], pos: Pos): number {
  return starts[pos.line] + pos.col;
}

function posOf(lines: readonly string[], starts: readonly number[], offset: number): Pos {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low, col: Math.min(offset - starts[low], (lines[low] ?? '').length) };
}

function allMatches(text: string, regex: RegExp): Located[] {
  const global = new RegExp(regex.source, `gm${regex.flags.replace(/[gm]/g, '')}`);
  const found: Located[] = [];
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) !== null) {
    found.push({ index: match.index, length: match[0].length });
    if (match[0].length === 0) global.lastIndex++;
    if (global.lastIndex > text.length) break;
  }
  return found;
}

export interface FindOptions {
  readonly forward: boolean;
  readonly count: number;
  readonly wrapscan: boolean;
  readonly anchor: 'start' | 'end';
  readonly ignoreCase: boolean;
  readonly acceptAtCursor?: boolean;
}

export function findMatch(lines: readonly string[], from: Pos, pattern: string, options: FindOptions): MatchResult | null {
  if (pattern === '') return null;
  const regex = compileVimPattern(pattern, options.ignoreCase);
  const text = lines.join('\n');
  const starts = lineStarts(lines);
  const origin = offsetOf(starts, from);
  const matches = allMatches(text, regex);
  if (matches.length === 0) return null;

  const key = (m: Located): number => (options.anchor === 'end' ? m.index + Math.max(0, m.length - 1) : m.index);
  const ahead = options.forward
    ? matches.filter((m) => (options.acceptAtCursor ? key(m) >= origin : key(m) > origin))
    : matches.filter((m) => key(m) < origin).reverse();
  const behind = options.forward
    ? matches.filter((m) => !(options.acceptAtCursor ? key(m) >= origin : key(m) > origin))
    : matches.filter((m) => key(m) >= origin).reverse();

  let wrapped = false;
  let chosen: Located | undefined;
  const sequence = options.wrapscan ? [...ahead, ...behind] : ahead;
  if (options.count - 1 < ahead.length) {
    chosen = ahead[options.count - 1];
  } else if (options.wrapscan && sequence.length > 0) {
    wrapped = true;
    chosen = sequence[(options.count - 1) % sequence.length];
  }
  if (!chosen) return null;
  const start = posOf(lines, starts, chosen.index);
  const end = posOf(lines, starts, chosen.index + chosen.length);
  return { start, end, wrapped };
}

function stepChars(lines: readonly string[], from: Pos, amount: number): Pos {
  let { line, col } = from;
  let remaining = amount;
  while (remaining > 0) {
    if (col + 1 <= (lines[line] ?? '').length - 1) col++;
    else if (line < lines.length - 1) { line++; col = 0; }
    else break;
    remaining--;
  }
  while (remaining < 0) {
    if (col > 0) col--;
    else if (line > 0) { line--; col = Math.max(0, (lines[line] ?? '').length - 1); }
    else break;
    remaining++;
  }
  return { line, col };
}

export function resolveTarget(lines: readonly string[], match: MatchResult, offset: SearchOffset): SearchTarget {
  const wrapped = match.wrapped;
  if (offset.kind === 'line') {
    const line = Math.max(0, Math.min(lines.length - 1, match.start.line + offset.amount));
    return { pos: { line, col: 0 }, linewise: true, inclusive: false, wrapped, match };
  }
  if (offset.kind === 'end') {
    const emptyMatch = match.end.line === match.start.line && match.end.col === match.start.col;
    const last = emptyMatch
      ? match.start
      : match.end.col > 0
        ? { line: match.end.line, col: match.end.col - 1 }
        : { line: match.end.line - 1, col: Math.max(0, (lines[match.end.line - 1] ?? '').length) };
    return { pos: stepChars(lines, last, offset.amount), linewise: false, inclusive: true, wrapped, match };
  }
  if (offset.kind === 'start') {
    return { pos: stepChars(lines, match.start, offset.amount), linewise: false, inclusive: false, wrapped, match };
  }
  return { pos: match.start, linewise: false, inclusive: false, wrapped, match };
}

function isKeyword(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_À-￿]/.test(ch);
}

export interface IdentUnderCursor {
  readonly text: string;
  readonly start: Pos;
  readonly isKeyword: boolean;
}

export function identUnderCursor(lines: readonly string[], from: Pos): IdentUnderCursor | null {
  const text = lines[from.line] ?? '';
  let col = from.col;
  while (col < text.length && !isKeyword(text[col])) col++;
  if (col < text.length) {
    let start = col;
    while (start > 0 && isKeyword(text[start - 1])) start--;
    let end = col;
    while (end < text.length && isKeyword(text[end])) end++;
    return { text: text.slice(start, end), start: { line: from.line, col: start }, isKeyword: true };
  }
  col = from.col;
  while (col < text.length && isWhite(text[col])) col++;
  if (col >= text.length) return null;
  let start = col;
  while (start > 0 && !isWhite(text[start - 1]) && !isKeyword(text[start - 1])) start--;
  let end = col;
  while (end < text.length && !isWhite(text[end])) end++;
  return { text: text.slice(start, end), start: { line: from.line, col: start }, isKeyword: false };
}

export function escapeForPattern(text: string, backwardDelimiter: boolean): string {
  return text.replace(/[\\.*$^~[\]/]/g, (c) => (c === '/' && backwardDelimiter ? c : '\\' + c));
}

export function patternForIdent(ident: IdentUnderCursor, wholeWord: boolean): string {
  const body = escapeForPattern(ident.text, false);
  if (!wholeWord) return body;
  const open = isKeyword(ident.text[0]) ? '\\<' : '';
  const close = isKeyword(ident.text[ident.text.length - 1]) ? '\\>' : '';
  return open + body + close;
}

import {
  Cursor, endWord, fwdWord, isWhite,
  type MotionBuffer, type MotionType, type Pos,
} from './VimCursor';
import { findMatchingBracket } from './VimMotions';
import { currentSentence } from './VimSentences';

export interface ObjectRange {
  readonly start: Pos;
  readonly end: Pos;
  readonly type: MotionType;
  readonly inclusive: boolean;
  readonly visualEnd?: Pos;
}

function lessOrEqual(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col);
}

function lessThan(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col < b.col);
}

function currentWord(buf: MotionBuffer, from: Pos, count: number, include: boolean, big: boolean): ObjectRange | null {
  const c = new Cursor(buf, from.line, from.col);
  let inclusive = true;
  let includeWhite = false;
  let startPos: Pos;
  let remaining = count;

  c.backInLine(big);
  startPos = c.pos();
  if ((c.cls(big) === 0) === include) {
    if (!endWord(c, 1, big, true, true)) return null;
  } else {
    fwdWord(c, 1, big, true);
    if (c.col === 0) c.decl();
    else c.oneLeft();
    if (include) includeWhite = true;
  }
  remaining--;

  while (remaining > 0) {
    inclusive = true;
    if (c.incl() === -1) return null;
    if (include !== (c.cls(big) === 0)) {
      if (!fwdWord(c, 1, big, true) && remaining > 1) return null;
      if (!c.oneLeft()) inclusive = false;
    } else if (!endWord(c, 1, big, true, true)) {
      return null;
    }
    remaining--;
  }

  if (includeWhite && (c.cls(big) !== 0 || (c.col === 0 && !inclusive))) {
    const saved = c.pos();
    c.line = startPos.line;
    c.col = startPos.col;
    if (c.oneLeft()) {
      c.backInLine(big);
      if (c.cls(big) === 0 && c.col > 0) startPos = c.pos();
    }
    c.line = saved.line;
    c.col = saved.col;
  }
  return { start: startPos, end: c.pos(), type: 'char', inclusive };
}

function lineWhite(buf: MotionBuffer, line: number): boolean {
  return /^[ \t]*$/.test(buf.lines[line] ?? '');
}

function startOfParagraph(buf: MotionBuffer, line: number): boolean {
  const text = buf.lines[line] ?? '';
  return text.length === 0 || text[0] === '\f';
}

function currentParagraph(buf: MotionBuffer, from: Pos, count: number, include: boolean): ObjectRange | null {
  const last = buf.lines.length - 1;
  let startLine = from.line;
  const whiteInFront = lineWhite(buf, startLine);
  while (startLine > 0) {
    if (whiteInFront) {
      if (!lineWhite(buf, startLine - 1)) break;
    } else if (lineWhite(buf, startLine - 1) || startOfParagraph(buf, startLine)) {
      break;
    }
    startLine--;
  }
  let endLine = startLine;
  while (endLine <= last && lineWhite(buf, endLine)) endLine++;
  endLine--;
  let i = count;
  if (!include && whiteInFront) i--;
  let doWhite = false;
  while (i-- > 0) {
    if (endLine === last) return null;
    if (!include) doWhite = lineWhite(buf, endLine + 1);
    if (include || !doWhite) {
      endLine++;
      while (endLine < last && !lineWhite(buf, endLine + 1) && !startOfParagraph(buf, endLine + 1)) endLine++;
    }
    if (i === 0 && whiteInFront && include) break;
    if (include || doWhite) {
      while (endLine < last && lineWhite(buf, endLine + 1)) endLine++;
    }
  }
  if (!whiteInFront && !lineWhite(buf, endLine) && include) {
    while (startLine > 0 && lineWhite(buf, startLine - 1)) startLine--;
  }
  return { start: { line: startLine, col: 0 }, end: { line: endLine, col: 0 }, type: 'line', inclusive: false };
}

function currentBlock(buf: MotionBuffer, from: Pos, count: number, include: boolean, what: string, other: string): ObjectRange | null {
  const c = new Cursor(buf, from.line, from.col);
  if (what === '{') {
    while (c.inIndent(1)) if (c.inc() !== 0) break;
  }
  if (c.text()[c.col] === what) c.col++;

  let startPos: Pos | null = null;
  let remaining = count;
  const enclosing = findMatchingBracket(buf, c.pos(), what) !== null;
  while (remaining-- > 0) {
    const hit = findMatchingBracket(buf, c.pos(), what, enclosing ? undefined : 'forward');
    if (hit === null) break;
    c.line = hit.line;
    c.col = hit.col;
    startPos = hit;
  }
  if (startPos === null) return null;
  const endPos = findMatchingBracket(buf, c.pos(), other);
  if (endPos === null) return null;
  c.line = endPos.line;
  c.col = endPos.col;

  let sol = false;
  const start = new Cursor(buf, startPos.line, startPos.col);
  while (!include) {
    start.incl();
    sol = c.col === 0;
    c.decl();
    while (c.inIndent(1)) {
      sol = true;
      if (c.decl() !== 0) break;
    }
    break;
  }
  let inclusive = false;
  if (!include) {
    if (sol) c.incl();
    else if (lessOrEqual(start.pos(), c.pos())) inclusive = true;
    else { c.line = start.line; c.col = start.col; }
    return { start: start.pos(), end: c.pos(), type: 'char', inclusive };
  }
  if (lessOrEqual(startPos, c.pos())) inclusive = true;
  return { start: startPos, end: c.pos(), type: 'char', inclusive };
}

function nextQuote(line: string, from: number, quote: string, escape: boolean): number {
  let col = from;
  for (;;) {
    const ch = line[col];
    if (ch === undefined) return -1;
    if (escape && ch === '\\') {
      col++;
      if (line[col] === undefined) return -1;
    } else if (ch === quote) {
      return col;
    }
    col++;
  }
}

function prevQuote(line: string, from: number, quote: string): number {
  let col = from;
  while (col > 0) {
    col--;
    let n = 0;
    while (col - n > 0 && line[col - n - 1] === '\\') n++;
    if (n & 1) col -= n;
    else if (line[col] === quote) break;
  }
  return col;
}

function currentQuote(buf: MotionBuffer, from: Pos, count: number, include: boolean, quote: string): ObjectRange | null {
  const line = buf.lines[from.line] ?? '';
  let colStart = from.col;
  let colEnd: number;
  if (line[colStart] === quote) {
    const firstCol = colStart;
    colStart = 0;
    for (;;) {
      colStart = nextQuote(line, colStart, quote, false);
      if (colStart < 0 || colStart > firstCol) return null;
      colEnd = nextQuote(line, colStart + 1, quote, true);
      if (colEnd < 0) return null;
      if (colStart <= firstCol && firstCol <= colEnd) break;
      colStart = colEnd + 1;
    }
  } else {
    colStart = prevQuote(line, colStart, quote);
    if (line[colStart] !== quote) {
      colStart = nextQuote(line, colStart, quote, false);
      if (colStart < 0) return null;
    }
    colEnd = nextQuote(line, colStart + 1, quote, true);
    if (colEnd < 0) return null;
  }
  if (include) {
    if (isWhite(line[colEnd + 1])) {
      while (isWhite(line[colEnd + 1])) colEnd++;
    } else {
      while (colStart > 0 && isWhite(line[colStart - 1])) colStart--;
    }
  }
  if (!include && count < 2) colStart++;
  const end = new Cursor(buf, from.line, colEnd);
  let inclusive = false;
  if ((include || count > 1) && end.inc() === 2) inclusive = true;
  return { start: { line: from.line, col: colStart }, end: end.pos(), type: 'char', inclusive };
}

const BLOCKS: Readonly<Record<string, readonly [string, string]>> = {
  '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'],
  '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'],
  '[': ['[', ']'], ']': ['[', ']'],
};

export function textObject(buf: MotionBuffer, from: Pos, inner: boolean, key: string, count: number): ObjectRange | null {
  switch (key) {
    case 'w': return currentWord(buf, from, count, !inner, false);
    case 'W': return currentWord(buf, from, count, !inner, true);
    case 'p': return currentParagraph(buf, from, count, !inner);
    case 's': {
      const range = currentSentence(buf, from, count, !inner);
      return range ? { start: range.start, end: range.end, type: 'char', inclusive: range.inclusive, visualEnd: range.visualEnd } : null;
    }
    case '"': case "'": case '`': return currentQuote(buf, from, count, !inner, key);
    default: {
      const pair = BLOCKS[key];
      if (pair) return currentBlock(buf, from, count, !inner, pair[0], pair[1]);
      return null;
    }
  }
}

export { lessThan };

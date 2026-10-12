import { isWhite, type MotionBuffer, type Pos } from './VimCursor';

const SENTENCE_END = '.!?';
const CLOSERS = ')]"\'';

function charAt(buf: MotionBuffer, pos: Pos): string {
  return (buf.lines[pos.line] ?? '')[pos.col] ?? '';
}

function lineIsEmpty(buf: MotionBuffer, line: number): boolean {
  return (buf.lines[line] ?? '') === '';
}

function startsParagraph(buf: MotionBuffer, line: number): boolean {
  const text = buf.lines[line] ?? '';
  return text === '' || text[0] === '\f';
}

export function inc(buf: MotionBuffer, pos: Pos): number {
  const text = buf.lines[pos.line] ?? '';
  if (pos.col < text.length) {
    pos.col++;
    return pos.col < text.length ? 0 : 2;
  }
  if (pos.line < buf.lines.length - 1) {
    pos.line++;
    pos.col = 0;
    return 1;
  }
  return -1;
}

export function incl(buf: MotionBuffer, pos: Pos): number {
  let r = inc(buf, pos);
  if (r >= 1 && pos.col) r = inc(buf, pos);
  return r;
}

function dec(buf: MotionBuffer, pos: Pos): number {
  if (pos.col > 0) {
    pos.col--;
    return 0;
  }
  if (pos.line > 0) {
    pos.line--;
    pos.col = (buf.lines[pos.line] ?? '').length;
    return 1;
  }
  return -1;
}

export function decl(buf: MotionBuffer, pos: Pos): number {
  let r = dec(buf, pos);
  if (r === 1 && pos.col) r = dec(buf, pos);
  return r;
}

export function findSentence(buf: MotionBuffer, from: Pos, forward: boolean, countIn: number): Pos | null {
  const pos: Pos = { ...from };
  const step = forward ? incl : decl;
  let count = countIn;
  let noskip = false;

  while (count--) {
    const previous: Pos = { ...pos };
    let jumpToFound = false;
    if (charAt(buf, pos) === '') {
      do {
        if (step(buf, pos) === -1) break;
      } while (charAt(buf, pos) === '');
      if (forward) jumpToFound = true;
    } else if (forward && pos.col === 0 && startsParagraph(buf, pos.line)) {
      if (pos.line === buf.lines.length - 1) return null;
      pos.line++;
      jumpToFound = true;
    } else if (!forward) {
      decl(buf, pos);
    }

    if (!jumpToFound) {
      let foundDot = false;
      for (;;) {
        const c = charAt(buf, pos);
        if (!(isWhite(c) || (c !== '' && (SENTENCE_END + CLOSERS).includes(c)))) break;
        const probe: Pos = { ...pos };
        if (decl(buf, probe) === -1 || (lineIsEmpty(buf, probe.line) && forward)) break;
        if (foundDot) break;
        if (SENTENCE_END.includes(c)) foundDot = true;
        const before = charAt(buf, probe);
        if (CLOSERS.includes(c) && !(before !== '' && (SENTENCE_END + CLOSERS).includes(before))) break;
        decl(buf, pos);
      }

      const startLine = pos.line;
      for (;;) {
        const c = charAt(buf, pos);
        if (c === '' || (pos.col === 0 && startsParagraph(buf, pos.line))) {
          if (!forward && pos.line !== startLine) pos.line++;
          break;
        }
        if (SENTENCE_END.includes(c)) {
          const probe: Pos = { ...pos };
          let next = '';
          let hitEnd = false;
          for (;;) {
            if (inc(buf, probe) === -1) { hitEnd = true; break; }
            next = charAt(buf, probe);
            if (!CLOSERS.includes(next) || next === '') break;
          }
          if (hitEnd || next === ' ' || next === '\t' || next === '') {
            pos.line = probe.line;
            pos.col = probe.col;
            if (charAt(buf, pos) === '') inc(buf, pos);
            break;
          }
        }
        if (step(buf, pos) === -1) {
          if (count) return null;
          noskip = true;
          break;
        }
      }
    }

    while (!noskip) {
      const c = charAt(buf, pos);
      if (c !== ' ' && c !== '\t') break;
      if (incl(buf, pos) === -1) break;
    }

    if (previous.line === pos.line && previous.col === pos.col) {
      if (step(buf, pos) === -1) {
        if (count) return null;
        break;
      }
      count++;
    }
  }
  return pos;
}

function findFirstBlank(buf: MotionBuffer, pos: Pos): void {
  while (decl(buf, pos) !== -1) {
    if (!isWhite(charAt(buf, pos))) {
      incl(buf, pos);
      break;
    }
  }
}

function findSentenceForward(buf: MotionBuffer, cursor: Pos, countIn: number, atStartIn: boolean): void {
  let count = countIn;
  let atStart = atStartIn;
  while (count--) {
    const next = findSentence(buf, cursor, true, 1);
    if (next) { cursor.line = next.line; cursor.col = next.col; }
    if (atStart) findFirstBlank(buf, cursor);
    if (count === 0 || atStart) decl(buf, cursor);
    atStart = !atStart;
  }
}

export interface SentenceRange {
  readonly start: Pos;
  readonly end: Pos;
  readonly inclusive: boolean;
  readonly visualEnd: Pos;
}

export function currentSentence(buf: MotionBuffer, from: Pos, count: number, include: boolean): SentenceRange | null {
  let startPos: Pos = { ...from };
  const pos: Pos = { ...from };
  const cursor: Pos = { ...from };
  const first = findSentence(buf, cursor, true, 1);
  if (first) { cursor.line = first.line; cursor.col = first.col; }

  while (isWhite(charAt(buf, pos))) incl(buf, pos);
  let startBlank: boolean;
  if (pos.line === cursor.line && pos.col === cursor.col) {
    startBlank = true;
    findFirstBlank(buf, startPos);
  } else {
    startBlank = false;
    const back = findSentence(buf, cursor, false, 1);
    if (back) { cursor.line = back.line; cursor.col = back.col; }
    startPos = { ...cursor };
  }

  let ncount: number;
  if (include) {
    ncount = count * 2;
  } else {
    ncount = count;
    if (startBlank) ncount--;
  }
  if (ncount > 0) findSentenceForward(buf, cursor, ncount, true);
  else decl(buf, cursor);

  if (include) {
    if (startBlank) {
      findFirstBlank(buf, cursor);
      if (isWhite(charAt(buf, cursor))) decl(buf, cursor);
    } else if (!isWhite(charAt(buf, cursor))) {
      findFirstBlank(buf, startPos);
    }
  }

  const visualEnd: Pos = { ...cursor };
  const end: Pos = { ...cursor };
  const inclusive = incl(buf, end) === -1;
  return { start: startPos, end, inclusive, visualEnd };
}

import {
  Cursor, MAXCOL, bckWord, bckendWord, colAtVcol, cursorVcol, endWord, firstNonBlank, fwdWord, isWhite,
  type FindState, type MotionBuffer, type MotionRequest, type MotionResult, type MotionType, type Pos,
} from './VimCursor';

export { MAXCOL, colAtVcol, cursorVcol, firstNonBlank, isWhite };
export type { FindState, MotionBuffer, MotionRequest, MotionResult, MotionType, Pos };

function clampNormal(buf: MotionBuffer, line: number, col: number): Pos {
  const text = buf.lines[line] ?? '';
  return { line, col: Math.max(0, Math.min(col, text.length - 1)) };
}

function cursorDown(buf: MotionBuffer, from: Pos, n: number): number | null {
  const last = buf.lines.length - 1;
  if (n > 0) {
    if (from.line >= last) return null;
    return from.line + n >= last ? last : from.line + n;
  }
  return from.line;
}

function cursorUp(buf: MotionBuffer, from: Pos, n: number): number | null {
  if (n > 0) {
    if (from.line <= 0) return null;
    return n >= from.line ? 0 : from.line - n;
  }
  return from.line;
}

function fail(from: Pos, type: MotionType = 'char', inclusive = false): MotionResult {
  return { pos: from, type, inclusive, failed: true, keepWant: true };
}

function searchChar(buf: MotionBuffer, from: Pos, count: number, find: FindState, repeat: boolean): { col: number; inclusive: boolean } | null {
  const text = buf.lines[from.line] ?? '';
  let stop = true;
  let forward = find.forward;
  let until = find.until;
  if (repeat) {
    if (until && count === 1) stop = false;
  }
  const inclusive = forward;
  let col = from.col;
  let remaining = count;
  while (remaining-- > 0) {
    for (;;) {
      if (forward) {
        col++;
        if (col >= text.length) return null;
      } else {
        if (col === 0) return null;
        col--;
      }
      if (text[col] === find.char && stop) break;
      stop = true;
    }
  }
  if (until) col -= forward ? 1 : -1;
  void until;
  return { col, inclusive };
}

function isParagraphBoundary(buf: MotionBuffer, line: number): boolean {
  const text = buf.lines[line] ?? '';
  return text.length === 0 || text[0] === '\f';
}

function findParagraph(buf: MotionBuffer, from: Pos, forward: boolean, count: number): { pos: Pos; inclusive: boolean } | null {
  const dir = forward ? 1 : -1;
  const lineCount = buf.lines.length;
  let curr = from.line;
  let remaining = count;
  while (remaining-- > 0) {
    let didSkip = false;
    for (let first = true; ; first = false) {
      if ((buf.lines[curr] ?? '').length !== 0) didSkip = true;
      if (!first && didSkip && isParagraphBoundary(buf, curr)) break;
      curr += dir;
      if (curr < 0 || curr >= lineCount) {
        if (remaining > 0) return null;
        curr -= dir;
        break;
      }
    }
  }
  if (curr === lineCount - 1 && forward) {
    const text = buf.lines[curr] ?? '';
    if (text.length !== 0) return { pos: { line: curr, col: text.length - 1 }, inclusive: true };
    return { pos: { line: curr, col: 0 }, inclusive: false };
  }
  return { pos: { line: curr, col: 0 }, inclusive: false };
}

const MATCH_PAIRS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

function previousBackslashes(line: string, col: number): number {
  let count = 0;
  for (let i = col - 1; i >= 0 && line[i] === '\\'; i--) count++;
  return count;
}

export function findMatchingBracket(buf: MotionBuffer, from: Pos, what?: string, forced?: 'forward' | 'backward'): Pos | null {
  const lines = buf.lines;
  let lnum = from.line;
  let col = from.col;
  let linep = lines[lnum] ?? '';
  let initc = '';
  let findc = '';
  let backwards = false;
  let commentDir: 0 | 1 | -1 = 0;
  let matchEscaped = false;

  const explicit = what !== undefined && what !== '';
  if (explicit) {
    const closeOf = MATCH_PAIRS[what!];
    if (closeOf !== undefined) { findc = what!; initc = closeOf; backwards = true; }
    else {
      const open = Object.keys(MATCH_PAIRS).find((k) => MATCH_PAIRS[k] === what);
      if (open === undefined) return null;
      findc = what!; initc = open; backwards = false;
    }
    if (forced !== undefined) backwards = forced === 'backward';
  }
  const ch = explicit ? undefined : linep[col];
  if (ch === '/') {
    if (linep[col + 1] === '*') { commentDir = 1; backwards = false; col++; }
    else if (col > 0 && linep[col - 1] === '*') { commentDir = -1; backwards = true; col--; }
  } else if (ch === '*') {
    if (linep[col + 1] === '/') { commentDir = -1; backwards = true; }
    else if (col > 0 && linep[col - 1] === '/') { commentDir = 1; backwards = false; }
  }
  if (commentDir === 0 && !explicit) {
    if (col >= linep.length && col > 0) col--;
    for (;;) {
      initc = linep[col] ?? '';
      if (initc === '') break;
      if (MATCH_PAIRS[initc] !== undefined) { findc = MATCH_PAIRS[initc]; backwards = false; break; }
      const open = Object.keys(MATCH_PAIRS).find((k) => MATCH_PAIRS[k] === initc);
      if (open !== undefined) { findc = open; backwards = true; break; }
      col++;
    }
    if (findc === '') return null;
    matchEscaped = previousBackslashes(linep, col) % 2 === 1;
  }

  let doQuotes = -1;
  let startInQuotes: 'maybe' | boolean = 'maybe';
  let inquote = false;
  let count = 0;
  let matchPos: Pos | null = null;
  let atStart = -1;

  for (;;) {
    if (backwards) {
      if (col === 0) {
        if (lnum === 0) break;
        lnum--;
        linep = lines[lnum] ?? '';
        col = linep.length;
        doQuotes = -1;
      } else {
        col--;
      }
    } else if (col >= linep.length) {
      if (lnum === lines.length - 1) break;
      lnum++;
      linep = lines[lnum] ?? '';
      col = 0;
      doQuotes = -1;
    } else {
      col++;
    }
    if (!backwards && col >= linep.length && commentDir === 0) {
      // the NUL position is visited so the end-of-line reset below can run
    }

    if (commentDir !== 0) {
      if (commentDir === 1) {
        if (linep[col] === '*' && linep[col + 1] === '/') return { line: lnum, col: col + 1 };
      } else {
        if (col === 0) continue;
        if (linep[col - 1] === '/' && linep[col] === '*' && (col === 1 || linep[col - 2] !== '*')) {
          count++;
          matchPos = { line: lnum, col: col - 1 };
        } else if (linep[col - 1] === '*' && linep[col] === '/') {
          if (count > 0) return matchPos;
          if (col > 1 && linep[col - 2] === '/') return { line: lnum, col: col - 2 };
          return null;
        }
      }
      continue;
    }

    if (doQuotes === -1) {
      atStart = doQuotes;
      let quotes = -1;
      for (let i = 0; i < linep.length; i++) {
        if (i === col + (backwards ? 1 : 0)) atStart = quotes & 1;
        if (linep[i] === '"' && (i === 0 || linep[i - 1] !== "'" || linep[i + 1] !== "'")) quotes++;
        if (linep[i] === '\\' && i + 1 < linep.length) i++;
      }
      doQuotes = quotes & 1;
      if (!doQuotes) {
        inquote = false;
        if (linep[linep.length - 1] === '\\') {
          doQuotes = 1;
          if (startInQuotes === 'maybe') { inquote = true; startInQuotes = true; } else if (backwards) inquote = true;
        }
        if (lnum > 0) {
          const prev = lines[lnum - 1] ?? '';
          if (prev.length > 0 && prev[prev.length - 1] === '\\') {
            doQuotes = 1;
            if (startInQuotes === 'maybe') {
              inquote = atStart === 1;
              if (inquote) startInQuotes = true;
            } else if (!backwards) inquote = true;
          }
        }
      }
    }
    if (startInQuotes === 'maybe') startInQuotes = false;

    const c = linep[col] ?? '';
    if (c === '') {
      if (col === 0 || linep[col - 1] !== '\\') { inquote = false; startInQuotes = false; }
      continue;
    }
    if (c === '"') {
      if (doQuotes) {
        let k = col - 1;
        while (k >= 0 && linep[k] === '\\') k--;
        if (((col - 1 - k) & 1) === 0) { inquote = !inquote; startInQuotes = false; }
      }
      continue;
    }
    if (c === "'" && initc !== "'" && findc !== "'") {
      if (backwards) {
        if (col > 1) {
          if (linep[col - 2] === "'") { col -= 2; continue; }
          if (linep[col - 2] === '\\' && col > 2 && linep[col - 3] === "'") { col -= 3; continue; }
        }
      } else if (linep[col + 1] !== undefined) {
        if (linep[col + 1] === '\\' && linep[col + 2] !== undefined && linep[col + 3] === "'") { col += 3; continue; }
        if (linep[col + 2] === "'") { col += 2; continue; }
      }
    }
    if ((!inquote || startInQuotes === true) && (c === initc || c === findc)) {
      const escaped = previousBackslashes(linep, col) % 2 === 1;
      if (escaped === matchEscaped) {
        if (c === initc) count++;
        else {
          if (count === 0) return { line: lnum, col };
          count--;
        }
      }
    }
  }
  return null;
}

export function runMotion(buf: MotionBuffer, from: Pos, req: MotionRequest): MotionResult | null {
  const count1 = req.count ?? 1;
  const text = buf.lines[from.line] ?? '';
  const lastLine = buf.lines.length - 1;
  switch (req.key) {
    case 'h': case 'ArrowLeft': case 'Backspace': {
      const wraps = req.key === 'Backspace';
      let line = from.line;
      let col = from.col;
      let moved = false;
      let noAdjust = false;
      for (let n = count1; n > 0; n--) {
        if (col > 0) { col--; moved = true; continue; }
        if (wraps && line > 0) {
          line--;
          col = Math.max(0, (buf.lines[line] ?? '').length - 1);
          moved = true;
          if (req.operator && (buf.lines[line] ?? '').length > 0) {
            col = (buf.lines[line] ?? '').length;
            noAdjust = true;
          }
          continue;
        }
        break;
      }
      const pos = { line, col };
      return moved || req.operator ? { pos, type: 'char', inclusive: false, noAdjustEnd: noAdjust } : { ...fail(from), pos };
    }
    case 'l': case 'ArrowRight': case ' ': {
      const wraps = req.key === ' ';
      let line = from.line;
      let col = from.col;
      let moved = false;
      let inclusive = false;
      for (let n = count1; n > 0; n--) {
        const cur = buf.lines[line] ?? '';
        if (req.visual && !wraps && col < cur.length) { col++; moved = true; continue; }
        if (col + 1 < cur.length) { col++; moved = true; continue; }
        if (wraps && line < lastLine) {
          if (req.operator && !inclusive && cur.length > 0) { inclusive = true; continue; }
          line++;
          col = 0;
          inclusive = false;
          moved = true;
          continue;
        }
        if (req.operator) {
          if (cur.length > 0) inclusive = true;
        }
        break;
      }
      const pos = { line, col };
      if (!moved && !req.operator) return { ...fail(from), pos };
      return { pos, type: 'char', inclusive };
    }
    case 'j': case 'ArrowDown': case 'k': case 'ArrowUp': case '+': case 'Enter': case '-': {
      const down = req.key === 'j' || req.key === 'ArrowDown' || req.key === '+' || req.key === 'Enter';
      const target = down ? cursorDown(buf, from, count1) : cursorUp(buf, from, count1);
      if (target === null) return fail(from, 'line');
      const targetText = buf.lines[target] ?? '';
      if (req.key === '+' || req.key === 'Enter' || req.key === '-') {
        return { pos: { line: target, col: firstNonBlank(targetText) }, type: 'line', inclusive: false };
      }
      const col = colAtVcol(targetText, req.want, buf.tabstop, req.visual);
      return { pos: { line: target, col }, type: 'line', inclusive: false, keepWant: true };
    }
    case 'gj': case 'gk': {
      const down = req.key === 'gj';
      const target = down ? Math.min(lastLine, from.line + count1) : Math.max(0, from.line - count1);
      const col = colAtVcol(buf.lines[target] ?? '', req.want, buf.tabstop, req.visual);
      const moved = target !== from.line;
      return { pos: { line: target, col }, type: 'char', inclusive: false, keepWant: true, ...(moved ? {} : { failed: true }) };
    }
    case '_': {
      const target = cursorDown(buf, from, count1 - 1);
      if (target === null) return fail(from, 'line');
      return { pos: { line: target, col: firstNonBlank(buf.lines[target] ?? '') }, type: 'line', inclusive: false };
    }
    case '0': case 'Home':
      return { pos: { line: from.line, col: 0 }, type: 'char', inclusive: false };
    case '^':
      return { pos: { line: from.line, col: firstNonBlank(text) }, type: 'char', inclusive: false };
    case '$': case 'End': {
      const target = cursorDown(buf, from, count1 - 1);
      if (target === null) return { ...fail(from, 'char', true), want: MAXCOL };
      const t = buf.lines[target] ?? '';
      return { pos: { line: target, col: req.visual ? t.length : Math.max(0, t.length - 1) }, type: 'char', inclusive: true, want: MAXCOL };
    }
    case 'g_': {
      const target = cursorDown(buf, from, count1 - 1);
      if (target === null) return { ...fail(from, 'char', true), want: MAXCOL };
      const t = buf.lines[target] ?? '';
      let col = Math.max(0, t.length - 1);
      while (col > 0 && isWhite(t[col])) col--;
      return { pos: { line: target, col }, type: 'char', inclusive: true, want: cursorVcol(t, col, buf.tabstop) };
    }
    case '|': {
      const col = req.count !== undefined && req.count > 0 ? colAtVcol(text, req.count - 1, buf.tabstop) : 0;
      return { pos: { line: from.line, col }, type: 'char', inclusive: false, want: req.count !== undefined && req.count > 0 ? req.count - 1 : 0 };
    }
    case 'G': case 'gg': {
      let line = req.key === 'G' ? lastLine : 0;
      if (req.count !== undefined && req.count !== 0) line = Math.max(0, Math.min(req.count - 1, lastLine));
      return { pos: { line, col: firstNonBlank(buf.lines[line] ?? '') }, type: 'line', inclusive: false };
    }
    case 'w': case 'W': {
      const c = new Cursor(buf, from.line, from.col);
      const big = req.key === 'W';
      let wordEnd = false;
      let inclusive = false;
      let flag = false;
      if (req.change) {
        const here = text[from.col];
        if (here !== undefined && !isWhite(here)) {
          inclusive = true;
          wordEnd = true;
          flag = true;
        }
      }
      const ok = wordEnd ? endWord(c, count1, big, flag, false) : fwdWord(c, count1, big, req.operator);
      let pos: Pos = { line: c.line, col: c.col };
      const moved = pos.line > from.line || (pos.line === from.line && pos.col > from.col);
      if (moved && !req.visual) {
        const t = buf.lines[pos.line] ?? '';
        if (pos.col > 0 && pos.col >= t.length) { pos = { line: pos.line, col: t.length - 1 }; inclusive = true; }
      }
      if (!ok && !req.operator) return { pos, type: 'char', inclusive, failed: true };
      return { pos, type: 'char', inclusive };
    }
    case 'e': case 'E': {
      const c = new Cursor(buf, from.line, from.col);
      const ok = endWord(c, count1, req.key === 'E', false, false);
      let pos: Pos = { line: c.line, col: c.col };
      const moved = pos.line > from.line || (pos.line === from.line && pos.col > from.col);
      let inclusive = true;
      if (moved) {
        const t = buf.lines[pos.line] ?? '';
        if (pos.col > 0 && pos.col >= t.length) { pos = { line: pos.line, col: t.length - 1 }; inclusive = true; }
      }
      if (!ok && !req.operator) return { pos, type: 'char', inclusive, failed: true };
      return { pos, type: 'char', inclusive };
    }
    case 'b': case 'B': {
      const c = new Cursor(buf, from.line, from.col);
      const ok = bckWord(c, count1, req.key === 'B', false);
      const pos: Pos = { line: c.line, col: c.col };
      if (!ok) return { pos, type: 'char', inclusive: false, failed: true };
      return { pos, type: 'char', inclusive: false };
    }
    case 'ge': case 'gE': {
      const c = new Cursor(buf, from.line, from.col);
      const ok = bckendWord(c, count1, req.key === 'gE', false);
      let pos: Pos = { line: c.line, col: c.col };
      const t = buf.lines[pos.line] ?? '';
      if (pos.col >= t.length && pos.col > 0) pos = { line: pos.line, col: t.length - 1 };
      if (!ok) return { pos, type: 'char', inclusive: true, failed: true };
      return { pos, type: 'char', inclusive: true };
    }
    case 'f': case 'F': case 't': case 'T': {
      if (req.arg === undefined) return null;
      const find: FindState = { char: req.arg, forward: req.key === 'f' || req.key === 't', until: req.key === 't' || req.key === 'T' };
      const hit = searchChar(buf, from, count1, find, false);
      if (!hit) return fail(from, 'char', find.forward);
      return { pos: { line: from.line, col: hit.col }, type: 'char', inclusive: hit.inclusive };
    }
    case ';': case ',': {
      const last = req.lastFind;
      if (!last) return fail(from);
      const find: FindState = { ...last, forward: req.key === ';' ? last.forward : !last.forward };
      const hit = searchChar(buf, from, count1, find, true);
      if (!hit) return fail(from, 'char', find.forward);
      return { pos: { line: from.line, col: hit.col }, type: 'char', inclusive: hit.inclusive };
    }
    case '}': case '{': {
      const hit = findParagraph(buf, from, req.key === '}', count1);
      if (!hit) return { pos: from, type: 'char', inclusive: false, failed: true };
      return { pos: hit.pos, type: 'char', inclusive: hit.inclusive };
    }
    case '%': {
      if (req.count !== undefined) {
        const line = Math.floor((req.count * buf.lines.length + 99) / 100) - 1;
        const clamped = Math.max(0, Math.min(line, lastLine));
        return { pos: { line: clamped, col: firstNonBlank(buf.lines[clamped] ?? '') }, type: 'line', inclusive: false };
      }
      const hit = findMatchingBracket(buf, from);
      if (!hit) return fail(from, 'char', true);
      return { pos: hit, type: 'char', inclusive: true };
    }
    default:
      return null;
  }
}

export { clampNormal };

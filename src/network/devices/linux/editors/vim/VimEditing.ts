import { isWhite, type Pos } from './VimCursor';

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

export function indentString(width: number, tabstop: number): string {
  return '\t'.repeat(Math.floor(width / tabstop)) + ' '.repeat(width % tabstop);
}

export function shiftLine(line: string, tabstop: number, shiftwidth: number, amount: number): string {
  if (line.length === 0) return line;
  const { width, chars } = indentWidth(line, tabstop);
  const rounded = width + amount * shiftwidth;
  return indentString(Math.max(0, rounded), tabstop) + line.slice(chars);
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

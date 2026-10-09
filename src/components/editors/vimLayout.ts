import { charCells, cursorVcol } from '@/network/devices/linux/editors/vim/VimCursor';

export type CaretShape = 'block' | 'bar' | 'underline';

export type SegmentKind = 'plain' | 'selected' | 'caret-block' | 'caret-bar' | 'caret-underline';

export interface Segment {
  readonly text: string;
  readonly kind: SegmentKind;
}

export type LineSelection =
  | { readonly kind: 'chars'; readonly from: number; readonly to: number; readonly eol: boolean }
  | { readonly kind: 'vcols'; readonly left: number; readonly right: number };

export interface LineLayoutOptions {
  readonly tabstop: number;
  readonly caretCol: number | null;
  readonly caret: CaretShape;
  readonly selection: LineSelection | null;
}

interface Cell {
  readonly ch: string;
  readonly col: number;
  readonly first: boolean;
  readonly vcol: number;
}

export function expandCells(text: string, tabstop: number): Cell[] {
  const cells: Cell[] = [];
  let vcol = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const width = charCells(ch, vcol, tabstop);
    if (ch === '\t') {
      for (let k = 0; k < width; k++) cells.push({ ch: ' ', col: i, first: k === 0, vcol: vcol + k });
    } else if (width === 2) {
      const code = ch.charCodeAt(0);
      const shown = code === 0x7f ? '?' : String.fromCharCode(code + 64);
      cells.push({ ch: '^', col: i, first: true, vcol });
      cells.push({ ch: shown, col: i, first: false, vcol: vcol + 1 });
    } else {
      cells.push({ ch, col: i, first: true, vcol });
    }
    vcol += width;
  }
  return cells;
}

export function cellIndexAtColumn(text: string, col: number, tabstop: number): number {
  const cells = expandCells(text, tabstop);
  const index = cells.findIndex((c) => c.col >= col);
  return index === -1 ? cells.length : index;
}

export function columnAtCell(text: string, cell: number, tabstop: number): number {
  const cells = expandCells(text, tabstop);
  if (cells.length === 0) return 0;
  if (cell >= cells.length) return text.length;
  return cells[Math.max(0, cell)].col;
}

function selected(cell: Cell, selection: LineSelection | null): boolean {
  if (!selection) return false;
  if (selection.kind === 'chars') return cell.col >= selection.from && cell.col <= selection.to;
  return cell.vcol >= selection.left && cell.vcol <= selection.right;
}

export function layoutLine(text: string, options: LineLayoutOptions): Segment[] {
  const cells = expandCells(text, options.tabstop);
  const kinds: SegmentKind[] = cells.map((c) => (selected(c, options.selection) ? 'selected' : 'plain'));
  const chars = cells.map((c) => c.ch);

  const wantsEolCell = options.selection?.kind === 'chars' && options.selection.eol;
  const caretAtEol = options.caretCol !== null && options.caretCol >= text.length;
  if (wantsEolCell || caretAtEol) {
    chars.push(' ');
    kinds.push(wantsEolCell && !caretAtEol ? 'selected' : 'plain');
  }

  if (options.caretCol !== null) {
    const caretKind: SegmentKind = `caret-${options.caret}` as SegmentKind;
    if (caretAtEol) {
      kinds[chars.length - 1] = caretKind;
    } else {
      const own = cells.map((c, i) => (c.col === options.caretCol ? i : -1)).filter((i) => i >= 0);
      const target = options.caret === 'block' ? own[own.length - 1] : own[0];
      if (target !== undefined) kinds[target] = caretKind;
    }
  }

  const segments: Segment[] = [];
  for (let i = 0; i < chars.length; i++) {
    const last = segments[segments.length - 1];
    if (last && last.kind === kinds[i] && last.kind !== 'caret-block' && last.kind !== 'caret-bar' && last.kind !== 'caret-underline') {
      segments[segments.length - 1] = { text: last.text + chars[i], kind: last.kind };
    } else {
      segments.push({ text: chars[i], kind: kinds[i] });
    }
  }
  return segments;
}

export interface VisualState {
  readonly mode: 'visual' | 'visual-line' | 'visual-block';
  readonly anchor: { readonly line: number; readonly col: number };
  readonly cursor: { readonly line: number; readonly col: number };
}

export function selectionForLine(
  lines: readonly string[],
  lineIndex: number,
  visual: VisualState | null,
  tabstop: number,
): LineSelection | null {
  if (!visual) return null;
  const text = lines[lineIndex] ?? '';
  const a = visual.anchor;
  const c = visual.cursor;
  const startsFirst = a.line < c.line || (a.line === c.line && a.col <= c.col);
  const start = startsFirst ? a : c;
  const end = startsFirst ? c : a;
  if (lineIndex < start.line || lineIndex > end.line) return null;

  if (visual.mode === 'visual-line') {
    return { kind: 'chars', from: 0, to: Math.max(0, text.length - 1), eol: true };
  }
  if (visual.mode === 'visual') {
    const from = lineIndex === start.line ? start.col : 0;
    const multi = lineIndex < end.line;
    const to = lineIndex === end.line ? end.col : Math.max(0, text.length - 1);
    return { kind: 'chars', from, to, eol: multi };
  }
  const aLine = lines[a.line] ?? '';
  const cLine = lines[c.line] ?? '';
  const aStart = cursorVcol(aLine, a.col, tabstop, false);
  const cStart = cursorVcol(cLine, c.col, tabstop, false);
  const aEnd = cursorVcol(aLine, a.col, tabstop, true);
  const cEnd = cursorVcol(cLine, c.col, tabstop, true);
  return { kind: 'vcols', left: Math.min(aStart, cStart), right: Math.max(aEnd, cEnd) };
}

export function rulerColumn(text: string, col: number, tabstop: number, insertMode: boolean): string {
  if (text.length === 0) return '0-1';
  const bytes = new TextEncoder().encode(text.slice(0, col)).length + 1;
  const virtual = cursorVcol(text, col, tabstop, !insertMode) + 1;
  return bytes === virtual ? String(bytes) : `${bytes}-${virtual}`;
}

import { codePointWidth } from '../vim/VimCells';

export type ScreenStyle =
  | 'linenr' | 'cursorlinenr' | 'nontext' | 'special' | 'visual' | 'colorcolumn' | 'modemsg' | 'error'
  | 'reverse' | 'alert';

export interface ScreenSpan {
  readonly from: number;
  readonly to: number;
  readonly style: ScreenStyle;
}

export interface ScreenRow {
  readonly text: string;
  readonly spans: readonly ScreenSpan[];
}

export interface ScreenCursor {
  readonly row: number;
  readonly col: number;
}

export interface EditorScreen {
  readonly rows: readonly ScreenRow[];
  readonly cursor: ScreenCursor | null;
}

export const CONTINUATION = '\u0000';

export function screenCells(text: string): string[] {
  const cells: string[] = [];
  for (const ch of text) {
    if (ch === CONTINUATION) {
      cells.push('');
    } else if (cells.length > 0 && codePointWidth(ch.codePointAt(0)!) === 0) {
      cells[cells.length - 1] += ch;
    } else {
      cells.push(ch);
    }
  }
  return cells;
}

export function plainRowText(row: ScreenRow): string {
  return row.text.split(CONTINUATION).join('');
}

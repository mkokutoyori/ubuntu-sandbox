import { codePointWidth } from '../vim/VimCells';

export type ScreenStyle =
  | 'linenr' | 'cursorlinenr' | 'nontext' | 'special' | 'visual' | 'colorcolumn' | 'modemsg' | 'error'
  | 'reverse' | 'bold' | 'alert' | 'search' | 'incsearch' | 'paint';

export interface Paint {
  readonly fg: number | null;
  readonly bg: number | null;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly reverse: boolean;
}

export interface ScreenSpan {
  readonly from: number;
  readonly to: number;
  readonly style: ScreenStyle;
  readonly paint?: Paint;
}

export function paintKey(paint: Paint): string {
  const flags = `${paint.bold ? 'b' : ''}${paint.italic ? 'i' : ''}${paint.underline ? 'u' : ''}${paint.reverse ? 'r' : ''}`;
  return `${paint.fg ?? '-'}/${paint.bg ?? '-'}/${flags}`;
}

export interface ScreenRow {
  readonly text: string;
  readonly spans: readonly ScreenSpan[];
}

export interface ScreenCursor {
  readonly row: number;
  readonly col: number;
}

export interface ScreenBand {
  readonly name: 'title' | 'edit' | 'status' | 'bars';
  readonly from: number;
  readonly to: number;
}

export interface EditorScreen {
  readonly rows: readonly ScreenRow[];
  readonly cursor: ScreenCursor | null;
  readonly bands?: readonly ScreenBand[];
  readonly hold?: { readonly millis: number; readonly then: EditorScreen };
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

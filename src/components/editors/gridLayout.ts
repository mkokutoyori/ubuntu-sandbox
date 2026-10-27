import { paintKey, screenCells, type Paint, type ScreenRow, type ScreenSpan, type ScreenStyle } from '@/network/devices/linux/editors/screen/EditorScreen';

export type CaretShape = 'block' | 'bar' | 'underline';

export interface GridRun {
  readonly text: string;
  readonly wide: boolean;
  readonly style: ScreenStyle | null;
  readonly paint: Paint | null;
  readonly caret: boolean;
}

interface GridCell {
  readonly ch: string;
  readonly wide: boolean;
  readonly style: ScreenStyle | null;
  readonly paint: Paint | null;
  readonly caret: boolean;
}

function spansOfCells(row: ScreenRow, count: number): (ScreenSpan | null)[] {
  const spans: (ScreenSpan | null)[] = new Array(count).fill(null);
  for (const span of row.spans) {
    for (let i = Math.max(0, span.from); i < span.to && i < count; i++) spans[i] = span;
  }
  return spans;
}

function samePaint(left: Paint | null, right: Paint | null): boolean {
  return left === right || (left !== null && right !== null && paintKey(left) === paintKey(right));
}

export function layoutRow(row: ScreenRow, caretCol: number | null): GridRun[] {
  const texts = screenCells(row.text);
  const cellSpans = spansOfCells(row, texts.length);
  const cells: GridCell[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i] === '' && i > 0) continue;
    cells.push({ ch: texts[i], wide: texts[i + 1] === '', style: cellSpans[i]?.style ?? null, paint: cellSpans[i]?.paint ?? null, caret: false });
  }
  if (caretCol !== null) {
    let column = 0;
    let index = -1;
    for (let i = 0; i < cells.length; i++) {
      const width = cells[i].wide ? 2 : 1;
      if (caretCol >= column && caretCol < column + width) { index = i; break; }
      column += width;
    }
    if (index === -1) {
      for (; column < caretCol; column++) cells.push({ ch: ' ', wide: false, style: null, paint: null, caret: false });
      cells.push({ ch: ' ', wide: false, style: null, paint: null, caret: true });
    } else {
      cells[index] = { ...cells[index], caret: true };
    }
  }
  const runs: GridRun[] = [];
  for (const cell of cells) {
    const last = runs[runs.length - 1];
    if (!cell.wide && !cell.caret && last && !last.wide && !last.caret && last.style === cell.style && samePaint(last.paint, cell.paint)) {
      runs[runs.length - 1] = { ...last, text: last.text + cell.ch };
    } else {
      runs.push({ text: cell.ch, wide: cell.wide, style: cell.style, paint: cell.paint, caret: cell.caret });
    }
  }
  return runs;
}

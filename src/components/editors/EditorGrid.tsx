import React, { type CSSProperties } from 'react';
import type { EditorScreen, ScreenRow, ScreenStyle } from '@/network/devices/linux/editors/screen/EditorScreen';
import { layoutRow, type CaretShape, type GridRun } from './gridLayout';
import { GRID_LINE_HEIGHT } from './gridMetrics';

const STYLES: Record<ScreenStyle, CSSProperties> = {
  linenr: { color: '#585b70' },
  cursorlinenr: { color: '#f9e2af' },
  nontext: { color: '#45475a' },
  special: { color: '#89b4fa' },
  visual: { backgroundColor: '#45475a' },
  colorcolumn: { backgroundColor: '#313244' },
  modemsg: { color: '#a6e3a1', fontWeight: 'bold' },
  error: { color: '#f38ba8' },
};

const CARETS: Record<CaretShape, CSSProperties> = {
  block: { backgroundColor: '#f5e0dc', color: '#1e1e2e' },
  bar: { boxShadow: 'inset 2px 0 0 #f5e0dc' },
  underline: { boxShadow: 'inset 0 -2px 0 #f5e0dc' },
};


function runStyle(run: GridRun, caret: CaretShape): CSSProperties {
  return {
    ...(run.style === null ? {} : STYLES[run.style]),
    ...(run.wide ? { display: 'inline-block', width: '2ch' } : {}),
    ...(run.caret ? CARETS[caret] : {}),
  };
}

interface GridRowsProps {
  readonly screen: EditorScreen;
  readonly caret: CaretShape;
  readonly rowTestId?: (row: ScreenRow, index: number) => string;
  readonly caretRef?: React.Ref<HTMLSpanElement>;
  readonly cursorTestId?: string;
}

export const GridRows: React.FC<GridRowsProps> = ({ screen, caret, rowTestId, caretRef, cursorTestId }) => (
  <>
    {screen.rows.map((row, index) => {
      const runs = layoutRow(row, screen.cursor !== null && screen.cursor.row === index ? screen.cursor.col : null);
      return (
        <div
          key={index}
          data-testid={rowTestId?.(row, index)}
          style={{ height: GRID_LINE_HEIGHT, lineHeight: `${GRID_LINE_HEIGHT}px`, whiteSpace: 'pre', overflow: 'hidden' }}
        >
          {runs.map((run, k) => (
            <span
              key={k}
              data-testid={run.caret ? cursorTestId : undefined}
              ref={run.caret ? caretRef : undefined}
              style={runStyle(run, caret)}
            >
              {run.text}
            </span>
          ))}
        </div>
      );
    })}
  </>
);

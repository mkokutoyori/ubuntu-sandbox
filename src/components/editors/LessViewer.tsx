import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import { LessEngine, type LessOptions, type LessSource } from '@/network/devices/linux/editors/LessEngine';
import { GridRows } from './EditorGrid';
import { GRID_FONT_FAMILY, GRID_FONT_SIZE, GRID_LINE_HEIGHT } from './gridMetrics';
import { useGridGeometry, type GridSize } from '../gridGeometry';
import { editorKeyOf } from './browserKeys';

interface LessViewerProps {
  sources: readonly LessSource[];
  options: LessOptions;
  quitIfOneScreen: boolean;
  initialKeys: string;
  help: 'only' | 'first' | null;
  onExit: (printed: string) => void;
}

const WHEEL_LINES = 3;

export const LessViewer: React.FC<LessViewerProps> = ({ sources, options, quitIfOneScreen, initialKeys, help, onExit }) => {
  const engineRef = useRef<LessEngine>();
  if (!engineRef.current) {
    engineRef.current = new LessEngine(sources, options);
    if (help !== null) engineRef.current.showHelpFirst(help === 'only');
    if (initialKeys !== '') engineRef.current.feed(initialKeys);
  }
  const engine = engineRef.current;
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const resized = useCallback((size: GridSize) => {
    engine.resize(Math.max(2, size.rows), size.cols);
    if (quitIfOneScreen && engine.fitsOnOneScreen()) {
      onExit(engine.plainContent);
      return;
    }
    bump();
  }, [engine, bump, quitIfOneScreen, onExit]);
  useGridGeometry(containerRef, engine, resized, GRID_LINE_HEIGHT);

  useEffect(() => {
    bodyRef.current?.focus();
  });

  const dispatch = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    engine.applyKey(editorKeyOf(e));
    if (engine.exited) {
      onExit('');
      return;
    }
    bump();
  }, [engine, onExit, bump]);

  const wheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY === 0) return;
    engine.scrollView(e.deltaY < 0, WHEEL_LINES);
    bump();
  }, [engine, bump]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative overflow-hidden"
      style={{ backgroundColor: '#1e1e2e', color: '#cdd6f4', fontFamily: GRID_FONT_FAMILY, fontSize: `${GRID_FONT_SIZE}px` }}
    >
      <div
        ref={bodyRef}
        data-testid="less-body"
        tabIndex={0}
        onKeyDown={dispatch}
        onWheel={wheel}
        className="absolute inset-0 outline-none"
      >
        <GridRows
          screen={engine.screen}
          caret="block"
          cursorTestId="less-cursor"
          rowTestId={(_row, index) => (index === engine.screen.rows.length - 1 ? 'less-status' : 'less-line')}
        />
      </div>
    </div>
  );
};

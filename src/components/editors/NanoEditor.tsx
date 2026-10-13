import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import type { NanoLaunchOptions } from '@/network/devices/linux/editors/NanoEngine';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';
import type { EditorFsContext } from '@/network/devices/linux/editors/EditorFsContext';
import type { EditorScreen } from '@/network/devices/linux/editors/screen/EditorScreen';
import { nanoLayout } from '@/network/devices/linux/editors/nano/NanoWindow';
import { GridRows } from './EditorGrid';
import { GRID_FONT_FAMILY, GRID_FONT_SIZE, GRID_LINE_HEIGHT } from './gridMetrics';
import { measureCell, useGridGeometry, type GridSize } from '../gridGeometry';

/**
 * What the renderer needs from whatever holds the buffer. A local
 * NanoEngine satisfies it directly; a RemoteNanoController satisfies it
 * over an SSH channel (docs/PRD-SSH-Unification.md §4bis B3).
 */
export type NanoEditorDriver = Pick<NanoEngine,
  | 'applyKey' | 'applyPaste' | 'screen' | 'resize' | 'scrollView' | 'clickAt' | 'exited' | 'savedOnExit'>;

interface NanoEditorProps {
  filePath: string;
  initialContent: string;
  isNewFile: boolean;
  fsContext?: EditorFsContext;
  /** Drive an already-open buffer instead of constructing a local one. */
  driver?: NanoEditorDriver;
  onExit: (saved: boolean) => void;
  launch?: NanoLaunch;
  displayName?: string;
}

const WHEEL_ROWS = 3;

function slice(screen: EditorScreen, from: number, to: number): EditorScreen {
  const cursor = screen.cursor !== null && screen.cursor.row >= from && screen.cursor.row < to
    ? { row: screen.cursor.row - from, col: screen.cursor.col }
    : null;
  return { rows: screen.rows.slice(from, to), cursor };
}

export const NanoEditor: React.FC<NanoEditorProps> = ({
  filePath,
  initialContent,
  isNewFile,
  fsContext,
  driver,
  onExit,
  launch,
  displayName,
}) => {
  const engineRef = useRef<NanoEditorDriver>();
  if (!engineRef.current) {
    const options: NanoLaunchOptions = { settings: launch?.settings, start: launch?.start, displayName };
    engineRef.current = driver ?? new NanoEngine(fsContext!, filePath, initialContent, isNewFile, false, undefined, false, options);
  }
  const engine = engineRef.current;
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const resized = useCallback((size: GridSize) => {
    engine.resize(Math.max(2, size.rows), size.cols);
    bump();
  }, [engine, bump]);
  useGridGeometry(containerRef, engine, resized, GRID_LINE_HEIGHT);

  useEffect(() => {
    bodyRef.current?.focus();
  });

  const dispatch = useCallback((e: React.KeyboardEvent) => {
    e.preventDefault();
    engine.applyKey({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    if (engine.exited) {
      onExit(engine.savedOnExit);
      return;
    }
    bump();
  }, [engine, onExit, bump]);

  const paste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    engine.applyPaste(e.clipboardData.getData('text'));
    bump();
  }, [engine, bump]);

  const wheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY === 0) return;
    engine.scrollView(e.deltaY > 0, WHEEL_ROWS);
    bump();
  }, [engine, bump]);

  const click = useCallback((e: React.MouseEvent) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = body.getBoundingClientRect();
    const cell = measureCell(body);
    if (!(cell > 0)) return;
    engine.clickAt(Math.floor((e.clientY - rect.top) / GRID_LINE_HEIGHT), Math.floor((e.clientX - rect.left) / cell));
    bump();
  }, [engine, bump]);

  const screen = engine.screen;
  const layout = nanoLayout(screen.rows.length);
  const editEnd = layout.editFrom + layout.editRows;
  const barsEnd = layout.barsFrom === null ? layout.statusRow + 1 : screen.rows.length;

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative overflow-hidden"
      style={{
        backgroundColor: '#300a24',
        color: '#d3d7cf',
        fontFamily: GRID_FONT_FAMILY,
        fontSize: `${GRID_FONT_SIZE}px`,
      }}
    >
      <div
        ref={bodyRef}
        data-testid="nano-body"
        tabIndex={0}
        onKeyDown={dispatch}
        onPaste={paste}
        onWheel={wheel}
        onMouseDown={click}
        className="absolute inset-0 outline-none"
      >
        {layout.titleRow !== null && (
          <div data-testid="nano-titlebar">
            <GridRows screen={slice(screen, 0, 1)} caret="block" cursorTestId="nano-cursor" />
          </div>
        )}
        <div data-testid="nano-edit">
          <GridRows screen={slice(screen, layout.editFrom, editEnd)} caret="block" cursorTestId="nano-cursor" />
        </div>
        <div data-testid="nano-status-message">
          <GridRows screen={slice(screen, layout.statusRow, layout.statusRow + 1)} caret="block" cursorTestId="nano-cursor" />
        </div>
        {layout.barsFrom !== null && (
          <div data-testid="nano-shortcut-bar">
            <GridRows screen={slice(screen, layout.barsFrom, barsEnd)} caret="block" cursorTestId="nano-cursor" />
          </div>
        )}
      </div>
    </div>
  );
};

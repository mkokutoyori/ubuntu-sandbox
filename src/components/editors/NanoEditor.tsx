import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import type { NanoLaunchOptions } from '@/network/devices/linux/editors/NanoEngine';
import type { NanoLaunch } from '@/network/devices/linux/editors/editorLaunch';
import type { EditorFsContext } from '@/network/devices/linux/editors/EditorFsContext';
import type { EditorScreen, ScreenBand } from '@/network/devices/linux/editors/screen/EditorScreen';
import { GridRows } from './EditorGrid';
import { useHeldScreen } from './useHeldScreen';
import { GRID_FONT_FAMILY, GRID_FONT_SIZE, GRID_LINE_HEIGHT } from './gridMetrics';
import { measureCell, useGridGeometry, type GridSize } from '../gridGeometry';
import { copySelectionToClipboard, isCopyGesture, isNativePasteGesture, pasteFromClipboard } from '../terminal/clipboard';
import { barShortcutAt, editorKeyOf } from './browserKeys';

/**
 * What the renderer needs from whatever holds the buffer. A local
 * NanoEngine satisfies it directly; a RemoteNanoController satisfies it
 * over an SSH channel (docs/PRD-SSH-Unification.md §4bis B3).
 */
export type NanoEditorDriver = Pick<NanoEngine,
  | 'applyKey' | 'applyPaste' | 'screen' | 'resize' | 'scrollView' | 'clickAt' | 'exited' | 'savedOnExit' | 'exitNotice'>;

interface NanoEditorProps {
  filePath: string;
  initialContent: string;
  isNewFile: boolean;
  fsContext?: EditorFsContext;
  /** Drive an already-open buffer instead of constructing a local one. */
  driver?: NanoEditorDriver;
  onExit: (saved: boolean, notice?: string) => void;
  launch?: NanoLaunch;
  displayName?: string;
}

const WHEEL_ROWS = 3;
const BROWSER_RESERVED_CODES = ['KeyW', 'KeyT', 'KeyN'];

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
    const options: NanoLaunchOptions = { settings: launch?.settings, start: launch?.start, displayName, rc: launch?.rc, menuFlags: launch?.menuFlags };
    engineRef.current = driver ?? new NanoEngine(fsContext!, filePath, initialContent, isNewFile, false, undefined, false, options);
  }
  const engine = engineRef.current;
  const { advance, shown } = useHeldScreen(engine);
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

  useEffect(() => {
    const keyboard = (navigator as Navigator & { keyboard?: { lock?: (codes: string[]) => Promise<void>; unlock?: () => void } }).keyboard;
    void keyboard?.lock?.(BROWSER_RESERVED_CODES)?.catch(() => undefined);
    return () => keyboard?.unlock?.();
  }, []);

  const dispatch = useCallback((e: React.KeyboardEvent) => {
    if (e.metaKey || isNativePasteGesture(e)) return;
    e.preventDefault();
    if (isCopyGesture(e)) {
      void copySelectionToClipboard();
      return;
    }
    advance();
    engine.applyKey(editorKeyOf(e));
    if (engine.exited) {
      onExit(engine.savedOnExit, engine.exitNotice);
      return;
    }
    bump();
  }, [engine, onExit, bump, advance]);

  const paste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    engine.applyPaste(e.clipboardData.getData('text'));
    bump();
  }, [engine, bump]);

  const pasteAtContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    void pasteFromClipboard().then((text) => {
      if (!text) return;
      engine.applyPaste(text);
      bump();
    });
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
    const row = Math.floor((e.clientY - rect.top) / GRID_LINE_HEIGHT);
    const col = Math.floor((e.clientX - rect.left) / cell);
    const current = shown(engine.screen);
    const bars = current.bands?.find((candidate) => candidate.name === 'bars');
    const key = bars !== undefined && row >= bars.from && row < bars.to
      ? barShortcutAt(current.rows.slice(bars.from, bars.to).map((line) => line.text), row - bars.from, col)
      : null;
    if (key !== null) {
      advance();
      engine.applyKey(key);
    } else {
      engine.clickAt(row, col);
    }
    if (engine.exited) {
      onExit(engine.savedOnExit, engine.exitNotice);
      return;
    }
    bump();
  }, [engine, onExit, bump, advance, shown]);

  const screen = shown(engine.screen);
  const band = (name: ScreenBand['name']): ScreenBand | undefined => screen.bands?.find((candidate) => candidate.name === name);
  const title = band('title');
  const edit = band('edit') ?? { name: 'edit', from: 0, to: screen.rows.length };
  const status = band('status') ?? { name: 'status', from: screen.rows.length - 1, to: screen.rows.length };
  const bars = band('bars');

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
        onContextMenu={pasteAtContextMenu}
        onWheel={wheel}
        onMouseUp={click}
        className="absolute inset-0 outline-none"
      >
        {title !== undefined && (
          <div data-testid="nano-titlebar">
            <GridRows screen={slice(screen, title.from, title.from + 1)} caret="block" cursorTestId="nano-cursor" />
          </div>
        )}
        <div data-testid="nano-edit">
          <GridRows screen={slice(screen, edit.from, edit.to)} caret="block" cursorTestId="nano-cursor" />
        </div>
        <div data-testid="nano-status-message">
          <GridRows screen={slice(screen, status.from, status.to)} caret="block" cursorTestId="nano-cursor" />
        </div>
        {bars !== undefined && (
          <div data-testid="nano-shortcut-bar">
            <GridRows screen={slice(screen, bars.from, bars.to)} caret="block" cursorTestId="nano-cursor" />
          </div>
        )}
      </div>
    </div>
  );
};

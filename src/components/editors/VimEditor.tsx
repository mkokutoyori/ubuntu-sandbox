/**
 * VimEditor - vim/vi terminal editor, rendered from a headless VimEngine
 * (src/network/devices/linux/editors/VimEngine.ts). The engine owns the
 * buffer/cursor/mode state machine and the screen (rows x columns of
 * cells, cursor cell, ruler, command line); this component measures the
 * space it is given, tells the engine, and paints the cells it gets back.
 */

import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import { VimEngine, type VimVariant } from '@/network/devices/linux/editors/VimEngine';
import type { EditorFsContext } from '@/network/devices/linux/editors/EditorFsContext';
import { GridRows } from './EditorGrid';
import { useHeldScreen } from './useHeldScreen';
import { GRID_FONT_FAMILY, GRID_FONT_SIZE, GRID_LINE_HEIGHT } from './gridMetrics';
import { measureCell, useGridGeometry, type GridSize } from '../gridGeometry';
import { editorKeyOf } from './browserKeys';
import { isNativePasteGesture, pasteFromClipboard } from '../terminal/clipboard';
import type { CaretShape } from './gridLayout';

/**
 * What the renderer needs from whatever holds the buffer. A local
 * VimEngine satisfies it directly; a RemoteVimController satisfies it
 * over an SSH channel (docs/PRD-SSH-Unification.md §4bis B3).
 */
export type VimEditorDriver = Pick<VimEngine,
  | 'applyKey' | 'applyPaste' | 'screen' | 'resize' | 'scrollView' | 'clickAt' | 'content' | 'mode'
  | 'exited' | 'savedOnExit' | 'isReplacing' | 'variant'
  | 'pendingBinaryWarning' | 'pendingSwapRecovery'>;

interface VimEditorProps {
  filePath: string;
  initialContent: string;
  isNewFile: boolean;
  editorName: VimVariant;
  fsContext?: EditorFsContext;
  /** Drive an already-open buffer instead of constructing a local one. */
  driver?: VimEditorDriver;
  owner?: string;
  onExit: (saved: boolean) => void;
  /** `vim +LINE file`: initial cursor line (1-indexed). */
  initialCursorLine?: number;
  displayName?: string;
}

const WHEEL_LINES = 3;

export const VimEditor: React.FC<VimEditorProps> = ({
  filePath,
  initialContent,
  isNewFile,
  editorName,
  fsContext,
  driver,
  owner,
  onExit,
  initialCursorLine,
  displayName,
}) => {
  const engineRef = useRef<VimEditorDriver>();
  if (!engineRef.current) {
    engineRef.current = driver ?? new VimEngine(
      fsContext!, filePath, initialContent, isNewFile, editorName, owner ?? 'user',
      initialCursorLine !== undefined ? { line: initialCursorLine } : undefined,
      displayName,
    );
  }
  const engine = engineRef.current;
  const [, bump] = useReducer((x: number) => x + 1, 0);
  const { advance, shown } = useHeldScreen(engine);

  const bodyRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const swapPromptRef = useRef<HTMLInputElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const resized = useCallback((size: GridSize) => {
    engine.resize(Math.max(2, size.rows), size.cols);
    bump();
  }, [engine, bump]);
  useGridGeometry(containerRef, engine, resized, GRID_LINE_HEIGHT);

  useEffect(() => {
    if (engine.mode === 'swap-recovery' || engine.mode === 'binary-warning') {
      swapPromptRef.current?.focus();
    } else {
      bodyRef.current?.focus();
      caretRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  });

  const dispatch = useCallback((e: React.KeyboardEvent) => {
    if (e.metaKey || isNativePasteGesture(e)) return;
    e.preventDefault();
    advance();
    engine.applyKey(editorKeyOf(e));
    if (engine.exited) {
      onExit(engine.savedOnExit);
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
    engine.scrollView(e.deltaY > 0, WHEEL_LINES);
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

  const caret: CaretShape = engine.mode === 'insert'
    ? (engine.isReplacing ? 'underline' : 'bar')
    : engine.mode === 'command' || engine.mode === 'search' ? 'bar' : 'block';

  const showSplash = isNewFile && engine.content === '' && engine.mode === 'normal';

  const promptStyle: React.CSSProperties = { backgroundColor: '#1e1e2e', color: '#cdd6f4' };
  const promptInput = (
    <input
      name="vimSwapPrompt"
      autoComplete="off"
      ref={swapPromptRef}
      onKeyDown={dispatch}
      className="absolute opacity-0 w-0 h-0"
      autoFocus
    />
  );

  let body: React.ReactNode;
  if (engine.mode === 'swap-recovery' && engine.pendingSwapRecovery) {
    const info = engine.pendingSwapRecovery;
    body = (
      <div className="h-full w-full flex flex-col items-center justify-center p-4" style={promptStyle}>
        <div style={{ color: '#f9e2af', fontWeight: 'bold' }}>E325: ATTENTION</div>
        <div className="mt-2">Found a swap file by the name &quot;{info.swapPath}&quot;</div>
        <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;owned by: {info.swapOwner}</div>
        <div>&nbsp;&nbsp;&nbsp;&nbsp;file name: {info.filePath}</div>
        <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;modified: YES</div>
        <div className="mt-2">Swap file &quot;{info.swapPath}&quot; already exists!</div>
        <div className="mt-2">
          {info.ownedBySameUser
            ? '[O]pen Read-Only, (E)dit anyway, (R)ecover, (Q)uit, (A)bort: '
            : '[O]pen Read-Only, (Q)uit, (A)bort: '}
        </div>
        {promptInput}
      </div>
    );
  } else if (engine.mode === 'binary-warning' && engine.pendingBinaryWarning) {
    body = (
      <div data-testid="vim-binary-warning" className="h-full w-full flex flex-col items-center justify-center p-4" style={promptStyle}>
        <div>{engine.pendingBinaryWarning}</div>
        {promptInput}
      </div>
    );
  } else {
    const live = engine.screen;
    const screen = shown(live);
    const lastRow = screen.rows.length - 1;
    body = (
      <div
        ref={bodyRef}
        data-testid="vim-body"
        tabIndex={0}
        onKeyDown={dispatch}
        onPaste={paste}
        onContextMenu={pasteAtContextMenu}
        onWheel={wheel}
        onMouseDown={click}
        className="absolute inset-0 outline-none"
      >
        <GridRows
          screen={screen}
          caret={caret}
          caretRef={caretRef}
          cursorTestId="vim-cursor"
          rowTestId={(row, index) => (
            index === lastRow ? 'vim-cmdline' : row.text === '~' ? 'vim-tilde' : 'vim-line'
          )}
        />
        {showSplash && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
            style={{ color: '#585b70' }}
          >
            <div className="text-xl mb-2 font-bold" style={{ color: '#cdd6f4' }}>
              {editorName === 'vim' ? 'VIM - Vi IMproved' : 'Vi'}
            </div>
            {editorName === 'vim' && (
              <>
                <div className="text-sm mb-1">version 8.2.4919</div>
                <div className="text-sm mb-1">by Bram Moolenaar et al.</div>
                <div className="text-sm mb-3">Modified by team+vim@tracker.debian.org</div>
              </>
            )}
            <div className="text-sm">type  :q&lt;Enter&gt;               to exit</div>
            <div className="text-sm">type  :help&lt;Enter&gt;  or  &lt;F1&gt;  for on-line help</div>
            <div className="text-sm">type  :help version8&lt;Enter&gt;   for version info</div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full relative overflow-hidden"
      style={{
        backgroundColor: '#1e1e2e',
        color: '#cdd6f4',
        fontFamily: GRID_FONT_FAMILY,
        fontSize: `${GRID_FONT_SIZE}px`,
      }}
    >
      {body}
    </div>
  );
};

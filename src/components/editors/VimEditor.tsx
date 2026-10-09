/**
 * VimEditor - vim/vi terminal editor, rendered from a headless VimEngine
 * (src/network/devices/linux/editors/VimEngine.ts). The engine owns the
 * buffer/cursor/mode state machine (NORMAL/INSERT/COMMAND-LINE/SEARCH)
 * and all filesystem/shell side effects (main file, swap file, `:!cmd`);
 * this component is a thin keystroke-forwarding renderer over it.
 */

import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import { layoutLine, selectionForLine, rulerColumn, type SegmentKind, type CaretShape, type VisualState } from './vimLayout';
import { VimEngine, type VimVariant } from '@/network/devices/linux/editors/VimEngine';
import type { EditorFsContext } from '@/network/devices/linux/editors/EditorFsContext';

/**
 * What the renderer needs from whatever holds the buffer. A local
 * VimEngine satisfies it directly; a RemoteVimController satisfies it
 * over an SSH channel (docs/PRD-SSH-Unification.md §4bis B3).
 */
export type VimEditorDriver = Pick<VimEngine,
  | 'applyKey' | 'renderListLine' | 'lines' | 'content' | 'mode' | 'message'
  | 'commandLineText' | 'searchText' | 'cursorLine' | 'cursorCol' | 'modified'
  | 'exited' | 'savedOnExit' | 'isReadOnly' | 'lineNumbersShown'
  | 'relativeNumbersShown' | 'listMode' | 'colorColumn' | 'fileFormat'
  | 'variant' | 'isRecordingMacro' | 'recordingMacroName'
  | 'pendingBinaryWarning' | 'pendingSubstMatch' | 'pendingSwapRecovery'
  | 'visualAnchor' | 'isReplacing' | 'searchPromptChar'>;

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
}

function segmentStyle(kind: SegmentKind): React.CSSProperties {
  switch (kind) {
    case 'selected': return { backgroundColor: '#45475a' };
    case 'caret-block': return { backgroundColor: '#f5e0dc', color: '#1e1e2e' };
    case 'caret-bar': return { boxShadow: 'inset 2px 0 0 #f5e0dc' };
    case 'caret-underline': return { boxShadow: 'inset 0 -2px 0 #f5e0dc' };
    default: return {};
  }
}

function caretColumnFor(text: string, col: number, renderList: ((line: string) => string) | null): number {
  return renderList ? renderList(text.slice(0, col)).replace(/\$$/, '').length : col;
}

/** Real vim's ruler position label: "All" when the whole file fits on
 *  screen, "Top"/"Bot" at either edge, otherwise a percentage. */
export function vimPositionLabel(cursorLine: number, totalLines: number, visibleLineCount: number): string {
  if (totalLines <= visibleLineCount) return 'All';
  if (cursorLine === 0) return 'Top';
  if (cursorLine === totalLines - 1) return 'Bot';
  return `${Math.round(((cursorLine + 1) / totalLines) * 100)}%`;
}

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
}) => {
  const engineRef = useRef<VimEditorDriver>();
  if (!engineRef.current) {
    engineRef.current = driver ?? new VimEngine(
      fsContext!, filePath, initialContent, isNewFile, editorName, owner ?? 'user',
      initialCursorLine !== undefined ? { line: initialCursorLine } : undefined,
    );
  }
  const engine = engineRef.current;
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const bodyRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const swapPromptRef = useRef<HTMLInputElement>(null);

  const lines = engine.lines;
  const totalLines = lines.length;
  const fileName = filePath.split('/').pop() || '[No Name]';
  const visibleLineCount = 30;

  useEffect(() => {
    if (engine.mode === 'command') {
      commandRef.current?.focus();
    } else if (engine.mode === 'search') {
      searchRef.current?.focus();
    } else if (engine.mode === 'swap-recovery') {
      swapPromptRef.current?.focus();
    } else {
      bodyRef.current?.focus();
      caretRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
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

  const focusedInBuffer = engine.mode !== 'command' && engine.mode !== 'search';
  const caret: CaretShape = engine.mode === 'insert' ? (engine.isReplacing ? 'underline' : 'bar') : 'block';
  const visual: VisualState | null =
    engine.mode === 'visual' || engine.mode === 'visual-line' || engine.mode === 'visual-block'
      ? { mode: engine.mode, anchor: engine.visualAnchor, cursor: { line: engine.cursorLine, col: engine.cursorCol } }
      : null;

  const showSplash = isNewFile && engine.content === '' && engine.mode === 'normal';

  if (engine.mode === 'swap-recovery' && engine.pendingSwapRecovery) {
    const info = engine.pendingSwapRecovery;
    return (
      <div
        className="h-full w-full flex flex-col items-center justify-center p-4"
        style={{
          backgroundColor: '#1e1e2e',
          color: '#cdd6f4',
          fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: '14px',
        }}
      >
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
        <input
          name="vimSwapPrompt"
          autoComplete="off"
          ref={swapPromptRef}
          onKeyDown={dispatch}
          className="absolute opacity-0 w-0 h-0"
          autoFocus
        />
      </div>
    );
  }

  if (engine.mode === 'binary-warning' && engine.pendingBinaryWarning) {
    return (
      <div
        data-testid="vim-binary-warning"
        className="h-full w-full flex flex-col items-center justify-center p-4"
        style={{
          backgroundColor: '#1e1e2e',
          color: '#cdd6f4',
          fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
          fontSize: '14px',
        }}
      >
        <div>{engine.pendingBinaryWarning}</div>
        <input
          name="vimSwapPrompt"
          autoComplete="off"
          ref={swapPromptRef}
          onKeyDown={dispatch}
          className="absolute opacity-0 w-0 h-0"
          autoFocus
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="h-full w-full flex flex-col"
      style={{
        backgroundColor: '#1e1e2e',
        color: '#cdd6f4',
        fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: '14px',
        lineHeight: '1.4',
      }}
    >
      <div
        ref={bodyRef}
        data-testid="vim-body"
        tabIndex={0}
        onKeyDown={dispatch}
        className="flex-1 overflow-y-auto overflow-x-hidden relative outline-none"
        style={{ backgroundColor: '#1e1e2e' }}
      >
        <div
          className="grid"
          style={{
            gridTemplateColumns: `${(engine.lineNumbersShown || engine.relativeNumbersShown) ? '3.5em' : '1em'} 1fr`,
            paddingTop: '2px',
            lineHeight: '1.4',
          }}
        >
          {lines.map((text, i) => {
            const isCursorLine = i === engine.cursorLine;
            let label = '';
            if (engine.relativeNumbersShown) {
              label = isCursorLine
                ? (engine.lineNumbersShown ? String(i + 1) : '0')
                : String(Math.abs(i - engine.cursorLine));
            } else if (engine.lineNumbersShown) {
              label = String(i + 1);
            }
            const shown = engine.listMode ? engine.renderListLine(text) : text;
            const segments = layoutLine(shown, {
              tabstop: 8,
              caretCol: isCursorLine && focusedInBuffer ? caretColumnFor(text, engine.cursorCol, engine.listMode ? engine.renderListLine : null) : null,
              caret,
              selection: selectionForLine(lines, i, visual, 8),
            });
            return (
              <React.Fragment key={i}>
                <div
                  data-testid="vim-gutter-cell"
                  className="select-none text-right pr-1"
                  style={{ backgroundColor: '#181825', color: isCursorLine ? '#cdd6f4' : '#585b70' }}
                >
                  {label}
                </div>
                <div
                  data-testid="vim-line"
                  className="pl-2"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', minHeight: '1.4em' }}
                >
                  {segments.map((seg, k) => (
                    <span
                      key={k}
                      data-testid={seg.kind.startsWith('caret') ? 'vim-cursor' : undefined}
                      ref={seg.kind.startsWith('caret') ? caretRef : undefined}
                      style={segmentStyle(seg.kind)}
                    >
                      {seg.text}
                    </span>
                  ))}
                </div>
              </React.Fragment>
            );
          })}
          {Array.from({ length: Math.max(0, visibleLineCount - totalLines) }).map((_, i) => (
            <React.Fragment key={`tilde-${i}`}>
              <div
                data-testid="vim-tilde"
                className="select-none"
                style={{ backgroundColor: '#181825', color: '#45475a', textAlign: 'left', paddingLeft: '4px', minHeight: '1.4em' }}
              >
                ~
              </div>
              <div />
            </React.Fragment>
          ))}
        </div>

        {engine.colorColumn !== null && (
          <div
            data-testid="vim-colorcolumn"
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{
              left: `calc(${(engine.lineNumbersShown || engine.relativeNumbersShown) ? '3.5em' : '1em'} + 0.5rem + ${engine.colorColumn}ch)`,
              width: '1px',
              backgroundColor: '#45475a',
            }}
          />
        )}

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

      {/* ── Status line (penultimate line) ──
          Real classic vi shows only the filename here — no live ruler, no
          [+] modified marker, no percentage. vim's full ruler (position +
          Top/Bot/All/N%) is a vim extension vi never had. */}
      <div
        data-testid="vim-statusline"
        className="flex items-center justify-between px-2 shrink-0"
        style={{
          backgroundColor: '#313244',
          color: '#cdd6f4',
          minHeight: '1.4em',
          fontSize: '13px',
        }}
      >
        <span>
          {engine.variant === 'vim' && engine.modified && <span style={{ color: '#f38ba8' }}>[+] </span>}
          {engine.isReadOnly && <span style={{ color: '#f9e2af' }}>[RO] </span>}
          <span>{fileName}</span>
          {engine.variant === 'vim' && engine.fileFormat === 'dos' && <span style={{ color: '#a6adc8' }}> [dos]</span>}
        </span>
        {engine.variant === 'vim' && (
          <span style={{ color: '#a6adc8' }}>
            {engine.isRecordingMacro && (
              <span style={{ color: '#f38ba8' }} className="mr-4">recording @{engine.recordingMacroName}</span>
            )}
            {engine.cursorLine + 1},{rulerColumn(lines[engine.cursorLine] ?? '', engine.cursorCol, 8, engine.mode === 'insert')}
            <span className="ml-4">
              {vimPositionLabel(engine.cursorLine, totalLines, visibleLineCount)}
            </span>
          </span>
        )}
      </div>

      {/* ── Command/message line (last line) ── */}
      <div
        className="px-2 shrink-0"
        style={{
          backgroundColor: '#1e1e2e',
          minHeight: '1.4em',
          fontSize: '13px',
        }}
      >
        {engine.mode === 'command' ? (
          <div className="flex items-center">
            <span style={{ color: '#cdd6f4' }}>:</span>
            <input
              name="vimCommand"
              autoComplete="off"
              ref={commandRef}
              value={engine.commandLineText}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={dispatch}
              className="flex-1 bg-transparent outline-none border-none"
              style={{
                color: '#cdd6f4',
                caretColor: '#f5e0dc',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              autoFocus
            />
          </div>
        ) : engine.mode === 'search' ? (
          <div className="flex items-center">
            <span style={{ color: '#cdd6f4' }}>{engine.searchPromptChar}</span>
            <input
              name="vimSearch"
              autoComplete="off"
              ref={searchRef}
              value={engine.searchText}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={dispatch}
              className="flex-1 bg-transparent outline-none border-none"
              style={{
                color: '#cdd6f4',
                caretColor: '#f5e0dc',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              autoFocus
            />
          </div>
        ) : engine.mode === 'confirm-substitute' && engine.pendingSubstMatch ? (
          <span style={{ color: '#cdd6f4' }}>
            replace with {engine.pendingSubstMatch.replacementPreview} (y/n/a/q/l)?
          </span>
        ) : engine.mode === 'visual' ? (
          <span style={{ color: '#a6e3a1', fontWeight: 'bold' }}>-- VISUAL --</span>
        ) : engine.mode === 'visual-line' ? (
          <span style={{ color: '#a6e3a1', fontWeight: 'bold' }}>-- VISUAL LINE --</span>
        ) : engine.mode === 'visual-block' ? (
          <span style={{ color: '#a6e3a1', fontWeight: 'bold' }}>-- VISUAL BLOCK --</span>
        ) : (
          <span style={{
            color: engine.message.startsWith('E') ? '#f38ba8' :
              (engine.message.includes('INSERT') || engine.message.includes('REPLACE')) ? '#a6e3a1' : '#a6adc8',
          }}>
            {engine.message}
          </span>
        )}
      </div>
    </div>
  );
};

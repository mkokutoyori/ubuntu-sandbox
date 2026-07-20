/**
 * NanoEditor - GNU nano terminal editor, rendered from a headless
 * NanoEngine (src/network/devices/linux/editors/NanoEngine.ts). The
 * engine owns the buffer/cursor/mode state machine and all filesystem
 * side effects (main file + lock/swap file); this component is a thin
 * keystroke-forwarding renderer over it.
 */

import React, { useRef, useEffect, useCallback, useReducer } from 'react';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import type { EditorFsContext } from '@/network/devices/linux/editors/EditorFsContext';

interface NanoEditorProps {
  filePath: string;
  initialContent: string;
  isNewFile: boolean;
  fsContext: EditorFsContext;
  onExit: (saved: boolean) => void;
  /** `nano -v`: buffer is immutable, no Write Out. */
  readOnly?: boolean;
  /** `nano -c`: title bar shows the live cursor position. */
  showPosition?: boolean;
  /** `nano -l`/`--linenumbers`: line-number gutter shown at open. */
  showLineNumbers?: boolean;
  /** `nano +LINE[,COLUMN] file`: initial cursor position (1-indexed). */
  initialCursorLine?: number;
  initialCursorCol?: number;
}

type Shortcut = readonly [string, string];

/** The bottom two-row shortcut bar is strictly contextual in real nano —
 *  only the keys meaningful in the active mode are ever shown. */
function shortcutsForMode(engine: NanoEngine): readonly [readonly Shortcut[], readonly Shortcut[]] {
  switch (engine.mode) {
    case 'search':
      return [
        [['^G', 'Help'], ['^W', 'Search'], ['M-C', 'Case Sens'], ['M-R', 'Regexp']],
        [['^C', 'Cancel'], ['M-B', 'Backwards']],
      ];
    case 'replace-search':
      return [
        [['^G', 'Help'], ['M-C', 'Case Sens'], ['M-R', 'Regexp']],
        [['^C', 'Cancel']],
      ];
    case 'replace-with':
      return [
        [['^G', 'Help'], ['M-C', 'Case Sens']],
        [['^C', 'Cancel']],
      ];
    case 'replace-confirm':
      return [
        [['^G', 'Help'], ['Y', 'Yes'], ['A', 'All']],
        [['N', 'No'], ['^C', 'Cancel']],
      ];
    case 'save-prompt':
      return [
        [['^G', 'Help']],
        [['^C', 'Cancel']],
      ];
    case 'exit-save-prompt':
      return [
        [['^G', 'Help'], ['Y', 'Yes']],
        [['N', 'No'], ['^C', 'Cancel']],
      ];
    case 'goto-line':
      return [
        [['^G', 'Help']],
        [['^C', 'Cancel']],
      ];
    case 'execute-prompt':
      return [
        [['^G', 'Help']],
        [['^C', 'Cancel']],
      ];
    case 'read-file-prompt':
      return [
        [['^G', 'Help']],
        [['^C', 'Cancel']],
      ];
    case 'help':
      return [
        [['^X', 'Exit Help']],
        [],
      ];
    case 'edit':
    default:
      if (engine.isReadOnly) {
        // View mode: no Write Out, Cut, Paste, Replace, Read File,
        // Execute, or Justify — nothing that could touch the buffer.
        return [
          [['^G', 'Help'], ['^W', 'Where Is']],
          [['^X', 'Exit'], ['^_', 'Go To Line']],
        ];
      }
      return [
        [['^G', 'Help'], ['^O', 'Write Out'], ['^W', 'Where Is'], ['^K', 'Cut'], ['^T', 'Execute']],
        [['^X', 'Exit'], ['^R', 'Read File'], ['^\\', 'Replace'], ['^U', 'Paste'], ['^J', 'Justify']],
      ];
  }
}

export const NanoEditor: React.FC<NanoEditorProps> = ({
  filePath,
  initialContent,
  isNewFile,
  fsContext,
  onExit,
  readOnly = false,
  showPosition = false,
  showLineNumbers = false,
  initialCursorLine,
  initialCursorCol,
}) => {
  const engineRef = useRef<NanoEngine>();
  if (!engineRef.current) {
    engineRef.current = new NanoEngine(
      fsContext, filePath, initialContent, isNewFile, readOnly,
      initialCursorLine !== undefined ? { line: initialCursorLine, col: initialCursorCol } : undefined,
      showLineNumbers,
    );
  }
  const engine = engineRef.current;
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (engine.mode === 'save-prompt') {
      saveInputRef.current?.focus();
      const pos = engine.promptCursor;
      saveInputRef.current?.setSelectionRange(pos, pos);
    } else if (engine.mode === 'exit-save-prompt' || engine.mode === 'replace-confirm') {
      // Hidden Y/N/A capture inputs — no text field, nothing to position.
      saveInputRef.current?.focus();
    } else if (engine.mode === 'search' || engine.mode === 'replace-search' || engine.mode === 'replace-with'
      || engine.mode === 'goto-line' || engine.mode === 'execute-prompt' || engine.mode === 'read-file-prompt') {
      searchInputRef.current?.focus();
      const pos = engine.promptCursor;
      searchInputRef.current?.setSelectionRange(pos, pos);
    } else {
      textareaRef.current?.focus();
      const pos = engine.displayCursorOffset;
      textareaRef.current?.setSelectionRange(pos, pos);
    }
  });

  const dispatch = useCallback((e: React.KeyboardEvent, forwardToApp = true) => {
    e.preventDefault();
    engine.applyKey({ key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
    if (engine.exited) {
      onExit(engine.savedOnExit);
      return;
    }
    if (forwardToApp) bump();
  }, [engine, onExit, bump]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => dispatch(e), [dispatch]);
  const handlePromptKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => dispatch(e), [dispatch]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    engine.applyPaste(e.clipboardData.getData('text'));
    bump();
  }, [engine, bump]);

  const handleEditMouseUp = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    const offset = e.currentTarget.selectionStart ?? 0;
    engine.moveCursorToDisplayOffset(offset);
    bump();
  }, [engine, bump]);

  const [shortcutsRow1, shortcutsRow2] = shortcutsForMode(engine);

  const titleStatus = engine.isReadOnly
    ? '[view]'
    : engine.modified
      ? 'Modified'
      : isNewFile
        ? 'New Buffer'
        : '';
  const titlePosition = showPosition
    ? `line ${engine.cursorLine + 1}/${engine.lines.length} col ${engine.cursorCol + 1}`
    : '';

  return (
    <div
      className="h-full w-full flex flex-col"
      style={{
        backgroundColor: '#300a24',
        color: '#d3d7cf',
        fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        fontSize: '14px',
        lineHeight: '1.35',
      }}
    >
      {/* ── Header bar (inverted: white bg, dark text, like real nano) ── */}
      <div
        data-testid="nano-titlebar"
        className="flex items-center shrink-0 px-2"
        style={{
          backgroundColor: '#d3d7cf',
          color: '#300a24',
          minHeight: '1.35em',
          fontWeight: 'bold',
        }}
      >
        <span className="mx-1">GNU nano 6.2</span>
        <span className="flex-1 text-center mx-1">{filePath}</span>
        <span className="mx-1">
          {titleStatus}
          {titleStatus && titlePosition && '    '}
          {titlePosition}
        </span>
      </div>

      {/* ── Editor content area (optional line-number gutter + textarea) ── */}
      <div className="flex-1 flex overflow-hidden">
        {engine.lineNumbersShown && engine.mode !== 'help' && (
          <div
            data-testid="nano-gutter"
            className="select-none shrink-0 text-right"
            style={{
              backgroundColor: '#300a24',
              color: '#585b70',
              minWidth: `${String(engine.lines.length).length + 1}ch`,
              paddingTop: '0.25rem',
              paddingRight: '0.5em',
              lineHeight: '1.35',
              fontSize: 'inherit',
              fontFamily: 'inherit',
            }}
          >
            {engine.lines.map((_, i) => (
              <div key={i} style={{ minHeight: '1.35em' }}>{i + 1}</div>
            ))}
          </div>
        )}
        <div className="flex-1 relative overflow-hidden">
        <textarea
          ref={textareaRef}
          data-testid="nano-textarea"
          value={engine.mode === 'help' ? engine.helpText : engine.displayContent}
          onChange={() => { /* content is engine-authoritative; keys drive all mutation */ }}
          onKeyDown={handleEditKeyDown}
          onPaste={engine.mode === 'help' ? undefined : handlePaste}
          onMouseUp={engine.mode === 'help' ? undefined : handleEditMouseUp}
          readOnly
          className="absolute inset-0 w-full h-full outline-none resize-none p-1"
          style={{
            backgroundColor: '#300a24',
            color: '#d3d7cf',
            fontFamily: 'inherit',
            fontSize: 'inherit',
            lineHeight: 'inherit',
            caretColor: '#ffffff',
            border: 'none',
            tabSize: 8,
          }}
          spellCheck={false}
          autoComplete="off"
        />
        {engine.mode === 'edit' && (
          <div
            data-testid="nano-caret"
            className="absolute pointer-events-none terminal-cursor"
            style={{
              top: `calc(0.25rem + ${engine.cursorLine} * 1.35em)`,
              left: `calc(0.25rem + ${engine.displayColumnFor(engine.cursorLine, engine.cursorCol)}ch)`,
              width: '2px',
              height: '1.2em',
              backgroundColor: '#ffffff',
            }}
          />
        )}
        {engine.mode === 'replace-confirm' && engine.pendingReplaceMatch && (() => {
          const m = engine.pendingReplaceMatch;
          const startCol = engine.displayColumnFor(m.line, m.start);
          const endCol = engine.displayColumnFor(m.line, m.end);
          return (
            <div
              data-testid="nano-replace-highlight"
              className="absolute pointer-events-none"
              style={{
                top: `calc(0.25rem + ${m.line} * 1.35em)`,
                left: `calc(0.25rem + ${startCol}ch)`,
                width: `${Math.max(1, endCol - startCol)}ch`,
                height: '1.35em',
                backgroundColor: 'rgba(255, 255, 0, 0.35)',
              }}
            />
          );
        })()}
        </div>
      </div>

      {/* ── Status message line (centered, above shortcuts) ── */}
      <div
        data-testid="nano-status-message"
        className="text-center shrink-0"
        style={{
          minHeight: '1.35em',
          color: engine.statusMessage.startsWith('[') ? '#d3d7cf' : '#ffffff',
          backgroundColor: '#300a24',
        }}
      >
        {engine.mode === 'save-prompt' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>File Name to Write: </span>
            <input
              ref={saveInputRef}
              value={engine.saveFileName}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'execute-prompt' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>Execute Command: </span>
            <input
              ref={searchInputRef}
              value={engine.executeCommandQuery}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'read-file-prompt' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>File to insert: </span>
            <input
              ref={searchInputRef}
              value={engine.readFileQuery}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'exit-save-prompt' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>Save modified buffer? &nbsp;</span>
            <span style={{ color: '#ffffff', fontWeight: 'bold' }}> Y</span>
            <span style={{ color: '#d3d7cf' }}>es</span>
            <span className="mx-1" />
            <span style={{ color: '#ffffff', fontWeight: 'bold' }}> N</span>
            <span style={{ color: '#d3d7cf' }}>o</span>
            <span className="mx-1" />
            <span style={{ color: '#ffffff', fontWeight: 'bold' }}> ^C</span>
            <span style={{ color: '#d3d7cf' }}> Cancel</span>
            <input
              ref={saveInputRef}
              onKeyDown={handlePromptKeyDown}
              className="absolute opacity-0 w-0 h-0"
              autoFocus
            />
          </div>
        )}
        {engine.mode === 'search' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>{engine.regexSearchEnabled ? 'Search [Regexp]: ' : 'Search: '}</span>
            <input
              ref={searchInputRef}
              value={engine.searchQuery}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'replace-search' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>
              {engine.regexSearchEnabled ? 'Search (to replace) [Regexp]: ' : 'Search (to replace): '}
            </span>
            <input
              ref={searchInputRef}
              value={engine.replaceSearchQuery}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'replace-with' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>Replace with: </span>
            <input
              ref={searchInputRef}
              value={engine.replaceWithText}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'goto-line' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>Enter line number, column number: </span>
            <input
              ref={searchInputRef}
              value={engine.gotoLineQuery}
              onChange={() => { /* engine-authoritative */ }}
              onKeyDown={handlePromptKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none"
              style={{
                color: '#ffffff',
                caretColor: '#ffffff',
                fontFamily: 'inherit',
                fontSize: 'inherit',
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}
        {engine.mode === 'replace-confirm' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>Replace this instance? &nbsp;</span>
            <span style={{ color: '#ffffff', fontWeight: 'bold' }}> Y</span>
            <span style={{ color: '#d3d7cf' }}>es</span>
            <span className="mx-1" />
            <span style={{ color: '#ffffff', fontWeight: 'bold' }}> N</span>
            <span style={{ color: '#d3d7cf' }}>o</span>
            <span className="mx-1" />
            <span style={{ color: '#ffffff', fontWeight: 'bold' }}> A</span>
            <span style={{ color: '#d3d7cf' }}>ll</span>
            <input
              ref={saveInputRef}
              onKeyDown={handlePromptKeyDown}
              className="absolute opacity-0 w-0 h-0"
              autoFocus
            />
          </div>
        )}
        {engine.mode === 'edit' && engine.statusMessage}
      </div>

      {/* ── Bottom shortcut bar (two rows, inverted colors like real nano) ── */}
      {/* Strictly contextual: shows exactly the shortcuts bound in the
          active mode (edit/search/replace/save/...), like real nano. */}
      <div data-testid="nano-shortcut-bar" className="shrink-0" style={{ backgroundColor: '#300a24' }}>
        {[shortcutsRow1, shortcutsRow2].map((row, rowIdx) => (
          <div key={rowIdx} className="flex flex-wrap" style={{ minHeight: '1.35em' }}>
            {row.map(([key, label]) => (
              <div key={key} className="flex" style={{ minWidth: '16.66%' }}>
                <span
                  style={{
                    backgroundColor: '#d3d7cf',
                    color: '#300a24',
                    paddingLeft: '2px',
                    paddingRight: '2px',
                    fontWeight: 'bold',
                  }}
                >
                  {key}
                </span>
                <span
                  style={{
                    color: '#d3d7cf',
                    paddingLeft: '2px',
                    paddingRight: '4px',
                  }}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

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
}

type Shortcut = readonly [string, string];

/** The bottom two-row shortcut bar is strictly contextual in real nano —
 *  only the keys meaningful in the active mode are ever shown. */
function shortcutsForMode(engine: NanoEngine): readonly [readonly Shortcut[], readonly Shortcut[]] {
  switch (engine.mode) {
    case 'search':
      return [
        [['^G', 'Help'], ['^W', 'Search'], ['M-C', 'Case Sens'], ['M-R', 'Regexp'], ['^R', 'Bck/Fwd']],
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
        [['^G', 'Help'], ['M-D', 'DOS Format'], ['M-A', 'Append'], ['M-B', 'Backup File']],
        [['^C', 'Cancel'], ['M-M', 'Mac Format'], ['M-P', 'Prepend']],
      ];
    case 'exit-save-prompt':
      return [
        [['^G', 'Help'], ['Y', 'Yes']],
        [['N', 'No'], ['^C', 'Cancel']],
      ];
    case 'edit':
    default:
      if (engine.isReadOnly) {
        // View mode: no Write Out, Cut, Paste, or Replace — nothing that
        // could touch the buffer is bound.
        return [
          [['^G', 'Help'], ['^W', 'Where Is'], ['^T', 'Execute']],
          [['^X', 'Exit'], ['^_', 'Go To Line']],
        ];
      }
      return [
        [['^G', 'Help'], ['^O', 'Write Out'], ['^W', 'Where Is'], ['^K', 'Cut'], ['^T', 'Execute']],
        [['^X', 'Exit'], ['^R', 'Read File'], ['^\\', 'Replace'], ['^U', 'Paste'], ['^J', 'Justify']],
      ];
  }
}

function flatOffset(lines: readonly string[], line: number, col: number): number {
  return lines.slice(0, line).join('\n').length + (line > 0 ? 1 : 0) + col;
}

export const NanoEditor: React.FC<NanoEditorProps> = ({
  filePath,
  initialContent,
  isNewFile,
  fsContext,
  onExit,
  readOnly = false,
  showPosition = false,
}) => {
  const engineRef = useRef<NanoEngine>();
  if (!engineRef.current) {
    engineRef.current = new NanoEngine(fsContext, filePath, initialContent, isNewFile, readOnly);
  }
  const engine = engineRef.current;
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (engine.mode === 'save-prompt' || engine.mode === 'exit-save-prompt' || engine.mode === 'replace-confirm') {
      saveInputRef.current?.focus();
    } else if (engine.mode === 'search' || engine.mode === 'replace-search' || engine.mode === 'replace-with') {
      searchInputRef.current?.focus();
    } else {
      textareaRef.current?.focus();
      const pos = flatOffset(engine.lines, engine.cursorLine, engine.cursorCol);
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

      {/* ── Editor content area ── */}
      <div className="flex-1 relative overflow-hidden">
        <textarea
          ref={textareaRef}
          value={engine.displayContent}
          onChange={() => { /* content is engine-authoritative; keys drive all mutation */ }}
          onKeyDown={handleEditKeyDown}
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

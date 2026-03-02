/**
 * NanoEditor - Realistic GNU nano 6.2 terminal editor
 *
 * Faithful reproduction of the real nano editor:
 * - Inverted header bar with "GNU nano 6.2" + filename
 * - Full-screen editing area with cursor
 * - Two-row shortcut bar at bottom (^G Help, ^O Write Out, etc.)
 * - Status messages appear centered above shortcuts
 * - Ctrl+O save flow with filename confirmation
 * - Ctrl+X exit with save prompt if modified
 * - Ctrl+K cut line, Ctrl+U paste line
 * - Ctrl+W search, Ctrl+G cursor position info
 * - Line wrapping, proper cursor tracking
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

interface NanoEditorProps {
  filePath: string;
  initialContent: string;
  isNewFile: boolean;
  onSave: (content: string, filePath: string) => void;
  onExit: () => void;
}

type NanoMode = 'edit' | 'save-prompt' | 'exit-save-prompt' | 'search';

export const NanoEditor: React.FC<NanoEditorProps> = ({
  filePath,
  initialContent,
  isNewFile,
  onSave,
  onExit,
}) => {
  const [content, setContent] = useState(initialContent);
  const [modified, setModified] = useState(false);
  const [mode, setMode] = useState<NanoMode>('edit');
  const [statusMessage, setStatusMessage] = useState(
    isNewFile ? '[ New File ]' : ''
  );
  const [statusTimeout, setStatusTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [saveFileName, setSaveFileName] = useState(filePath);
  const [searchQuery, setSearchQuery] = useState('');
  const [cutBuffer, setCutBuffer] = useState<string[]>([]);
  const [cursorLine, setCursorLine] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const fileName = filePath.split('/').pop() || 'New Buffer';

  // Focus management
  useEffect(() => {
    if (mode === 'save-prompt' || mode === 'exit-save-prompt') {
      saveInputRef.current?.focus();
    } else if (mode === 'search') {
      searchInputRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Show a temporary status message
  const showStatus = useCallback((msg: string, duration = 3000) => {
    if (statusTimeout) clearTimeout(statusTimeout);
    setStatusMessage(msg);
    if (duration > 0) {
      const t = setTimeout(() => setStatusMessage(''), duration);
      setStatusTimeout(t);
    }
  }, [statusTimeout]);

  // Track cursor position
  const updateCursorPosition = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const textBefore = content.slice(0, pos);
    const lines = textBefore.split('\n');
    setCursorLine(lines.length - 1);
    setCursorCol(lines[lines.length - 1].length);
  }, [content]);

  // Handle keyboard in edit mode
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!e.ctrlKey) {
      // Update cursor on next tick
      setTimeout(updateCursorPosition, 0);
      return;
    }

    // Ctrl+O — Write Out (Save)
    if (e.key === 'o' || e.key === 'O') {
      e.preventDefault();
      setSaveFileName(filePath);
      setMode('save-prompt');
      return;
    }

    // Ctrl+X — Exit
    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      if (modified) {
        setMode('exit-save-prompt');
        showStatus('Save modified buffer?', 0);
      } else {
        onExit();
      }
      return;
    }

    // Ctrl+K — Cut current line
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      const lines = content.split('\n');
      if (cursorLine < lines.length) {
        const cutLine = lines[cursorLine];
        setCutBuffer(prev => [...prev, cutLine]);
        lines.splice(cursorLine, 1);
        if (lines.length === 0) lines.push('');
        setContent(lines.join('\n'));
        setModified(true);
        showStatus('Cut 1 line');
      }
      return;
    }

    // Ctrl+U — Paste (Uncut)
    if (e.key === 'u' || e.key === 'U') {
      e.preventDefault();
      if (cutBuffer.length > 0) {
        const lines = content.split('\n');
        lines.splice(cursorLine, 0, ...cutBuffer);
        setContent(lines.join('\n'));
        setModified(true);
        showStatus(`Pasted ${cutBuffer.length} line(s)`);
      }
      return;
    }

    // Ctrl+W — Search
    if (e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      setSearchQuery('');
      setMode('search');
      return;
    }

    // Ctrl+G — Help / Cursor position
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      const totalLines = content.split('\n').length;
      const totalChars = content.length;
      const linePercent = totalLines > 0 ? Math.round(((cursorLine + 1) / totalLines) * 100) : 100;
      showStatus(
        `[ line ${cursorLine + 1}/${totalLines} (${linePercent}%), col ${cursorCol + 1}, char ${textareaRef.current?.selectionStart || 0}/${totalChars} ]`
      );
      return;
    }

    // Ctrl+C — Show cursor position (like nano)
    if (e.key === 'c' || e.key === 'C') {
      e.preventDefault();
      const totalLines = content.split('\n').length;
      showStatus(`[ line ${cursorLine + 1}/${totalLines}, col ${cursorCol + 1} ]`);
      return;
    }

    setTimeout(updateCursorPosition, 0);
  }, [content, cursorLine, cursorCol, cutBuffer, filePath, modified, onExit, showStatus, updateCursorPosition]);

  // Handle save prompt
  const handleSavePromptKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSave(content, saveFileName);
      setModified(false);
      const lines = content.split('\n').length;
      const chars = content.length;
      showStatus(`[ Wrote ${lines} line(s), ${chars} character(s) to ${saveFileName} ]`);
      setMode('edit');
      return;
    }
    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      e.preventDefault();
      showStatus('Cancelled');
      setMode('edit');
    }
  }, [content, saveFileName, onSave, showStatus]);

  // Handle exit-save prompt (Y/N/^C)
  const handleExitSaveKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'y' || e.key === 'Y') {
      e.preventDefault();
      onSave(content, filePath);
      onExit();
      return;
    }
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      onExit();
      return;
    }
    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      e.preventDefault();
      setStatusMessage('');
      setMode('edit');
    }
  }, [content, filePath, onSave, onExit]);

  // Handle search
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchQuery) {
        const pos = content.indexOf(searchQuery, (textareaRef.current?.selectionStart || 0) + 1);
        if (pos >= 0) {
          textareaRef.current?.setSelectionRange(pos, pos + searchQuery.length);
          textareaRef.current?.focus();
          showStatus('');
        } else {
          // Wrap around search
          const wrapPos = content.indexOf(searchQuery);
          if (wrapPos >= 0) {
            textareaRef.current?.setSelectionRange(wrapPos, wrapPos + searchQuery.length);
            textareaRef.current?.focus();
            showStatus('[ Search Wrapped ]');
          } else {
            showStatus(`[ "${searchQuery}" not found ]`);
          }
        }
      }
      setMode('edit');
      return;
    }
    if (e.key === 'Escape' || (e.ctrlKey && (e.key === 'c' || e.key === 'C'))) {
      e.preventDefault();
      setMode('edit');
    }
  }, [searchQuery, content, showStatus]);

  const lines = content.split('\n');
  const totalLines = lines.length;

  // Shortcut definitions for the bottom bar (matching real nano)
  const shortcuts = [
    ['^G', 'Help'],     ['^O', 'Write Out'], ['^W', 'Where Is'],  ['^K', 'Cut'],
    ['^C', 'Location'], ['^X', 'Exit'],      ['^R', 'Read File'], ['^\\ ', 'Replace'],
    ['^U', 'Paste'],    ['^J', 'Justify'],   ['^T', 'Execute'],   ['^_', 'Go To Line'],
  ];

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
        className="flex items-center justify-center shrink-0 px-2"
        style={{
          backgroundColor: '#d3d7cf',
          color: '#300a24',
          minHeight: '1.35em',
          fontWeight: 'bold',
        }}
      >
        <span className="mx-1">GNU nano 6.2</span>
        {modified && <span className="mx-2">Modified</span>}
        <span className="mx-1">
          {isNewFile ? 'New Buffer' : fileName}
        </span>
      </div>

      {/* ── Editor content area ── */}
      <div className="flex-1 relative overflow-hidden">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            setModified(true);
            setTimeout(updateCursorPosition, 0);
          }}
          onKeyDown={handleKeyDown}
          onClick={updateCursorPosition}
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
        className="text-center shrink-0"
        style={{
          minHeight: '1.35em',
          color: statusMessage.startsWith('[') ? '#d3d7cf' : '#ffffff',
          backgroundColor: '#300a24',
        }}
      >
        {mode === 'save-prompt' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>File Name to Write: </span>
            <input
              ref={saveInputRef}
              value={saveFileName}
              onChange={(e) => setSaveFileName(e.target.value)}
              onKeyDown={handleSavePromptKeyDown}
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
        {mode === 'exit-save-prompt' && (
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
              onKeyDown={handleExitSaveKeyDown}
              className="absolute opacity-0 w-0 h-0"
              autoFocus
            />
          </div>
        )}
        {mode === 'search' && (
          <div className="flex items-center px-1">
            <span style={{ color: '#d3d7cf' }}>Search: </span>
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
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
        {mode === 'edit' && statusMessage}
      </div>

      {/* ── Bottom shortcut bar (two rows, inverted colors like real nano) ── */}
      <div className="shrink-0" style={{ backgroundColor: '#300a24' }}>
        {[0, 1].map((row) => (
          <div key={row} className="flex flex-wrap" style={{ minHeight: '1.35em' }}>
            {shortcuts.slice(row * 6, row * 6 + 6).map(([key, label]) => (
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

/**
 * VimEditor - Realistic Vim 8.2 terminal editor
 *
 * Faithful reproduction of the real vim/vi editor:
 * - Normal mode: navigate, delete, yank, paste
 * - Insert mode: free text editing (i, a, o, O, A, I)
 * - Command-line mode: :w, :q, :wq, :q!, :set, etc.
 * - Visual mode indicator
 * - Tilde (~) lines for empty buffer space
 * - Status line: filename, [+] modified, line/col count
 * - Command/message line at the very bottom
 * - Line numbers (like :set number)
 * - Proper VIM splash screen for empty new files
 * - dd to delete line, yy to yank, p to paste
 * - / for forward search
 * - gg, G for top/bottom navigation
 * - x to delete char, r to replace char
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';

interface VimEditorProps {
  filePath: string;
  initialContent: string;
  isNewFile: boolean;
  editorName: 'vim' | 'vi';
  onSave: (content: string, filePath: string) => void;
  onExit: () => void;
}

type VimMode = 'normal' | 'insert' | 'command' | 'search';

export const VimEditor: React.FC<VimEditorProps> = ({
  filePath,
  initialContent,
  isNewFile,
  editorName,
  onSave,
  onExit,
}) => {
  const [content, setContent] = useState(initialContent);
  const [mode, setMode] = useState<VimMode>('normal');
  const [command, setCommand] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [modified, setModified] = useState(false);
  const [message, setMessage] = useState(
    isNewFile ? `"${filePath}" [New File]` : `"${filePath}" ${initialContent.split('\n').length}L, ${initialContent.length}C`
  );
  const [cursorLine, setCursorLine] = useState(0);
  const [cursorCol, setCursorCol] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [yankBuffer, setYankBuffer] = useState<string[]>([]);
  const [pendingKey, setPendingKey] = useState('');
  const [insertSubMode, setInsertSubMode] = useState<'i' | 'a' | 'o' | 'O' | 'A' | 'I'>('i');

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const lines = content.split('\n');
  const totalLines = lines.length;
  const fileName = filePath.split('/').pop() || '[No Name]';

  // Calculate visible lines based on container height
  const visibleLineCount = 30; // Approximate

  // Focus management
  useEffect(() => {
    if (mode === 'command') {
      commandRef.current?.focus();
    } else if (mode === 'search') {
      searchRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [mode]);

  // Update cursor tracking
  const updateCursorFromTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const textBefore = content.slice(0, pos);
    const beforeLines = textBefore.split('\n');
    setCursorLine(beforeLines.length - 1);
    setCursorCol(beforeLines[beforeLines.length - 1].length);
  }, [content]);

  // Execute vim command-line commands
  const executeVimCommand = useCallback((cmd: string) => {
    const trimmed = cmd.trim();

    // :w - write
    if (trimmed === 'w' || trimmed === 'write') {
      onSave(content, filePath);
      setModified(false);
      setMessage(`"${filePath}" ${totalLines}L, ${content.length}C written`);
      setMode('normal');
      return;
    }

    // :w filename - write to specific file
    if (trimmed.startsWith('w ')) {
      const newFile = trimmed.slice(2).trim();
      onSave(content, newFile);
      setModified(false);
      setMessage(`"${newFile}" ${totalLines}L, ${content.length}C written`);
      setMode('normal');
      return;
    }

    // :q - quit
    if (trimmed === 'q' || trimmed === 'quit') {
      if (modified) {
        setMessage('E37: No write since last change (add ! to override)');
        setMode('normal');
      } else {
        onExit();
      }
      return;
    }

    // :q! - force quit
    if (trimmed === 'q!' || trimmed === 'quit!') {
      onExit();
      return;
    }

    // :wq or :x - write and quit
    if (trimmed === 'wq' || trimmed === 'x' || trimmed === 'wq!') {
      onSave(content, filePath);
      onExit();
      return;
    }

    // :set number / :set nonumber
    if (trimmed === 'set number' || trimmed === 'set nu') {
      setMessage('');
      setMode('normal');
      return;
    }

    // :N - go to line N
    const lineNum = parseInt(trimmed, 10);
    if (!isNaN(lineNum) && lineNum > 0) {
      const targetLine = Math.min(lineNum - 1, totalLines - 1);
      setCursorLine(targetLine);
      setCursorCol(0);
      // Move textarea cursor
      const pos = lines.slice(0, targetLine).join('\n').length + (targetLine > 0 ? 1 : 0);
      textareaRef.current?.setSelectionRange(pos, pos);
      setMessage('');
      setMode('normal');
      return;
    }

    // :$ - go to last line
    if (trimmed === '$') {
      const lastLine = totalLines - 1;
      setCursorLine(lastLine);
      setCursorCol(0);
      setMessage('');
      setMode('normal');
      return;
    }

    setMessage(`E492: Not an editor command: ${trimmed}`);
    setMode('normal');
  }, [content, filePath, modified, totalLines, lines, onSave, onExit]);

  // Handle normal mode keys
  const handleNormalKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();

    const key = e.key;

    // Handle pending keys (like dd, yy, gg)
    if (pendingKey) {
      if (pendingKey === 'd' && key === 'd') {
        // dd - delete entire line
        const newLines = [...lines];
        const deleted = newLines.splice(cursorLine, 1);
        if (newLines.length === 0) newLines.push('');
        setYankBuffer(deleted);
        setContent(newLines.join('\n'));
        setModified(true);
        setCursorLine(Math.min(cursorLine, newLines.length - 1));
        setMessage(`1 line yanked`);
        setPendingKey('');
        return;
      }
      if (pendingKey === 'y' && key === 'y') {
        // yy - yank line
        setYankBuffer([lines[cursorLine]]);
        setMessage('1 line yanked');
        setPendingKey('');
        return;
      }
      if (pendingKey === 'g' && key === 'g') {
        // gg - go to top
        setCursorLine(0);
        setCursorCol(0);
        const ta = textareaRef.current;
        if (ta) ta.setSelectionRange(0, 0);
        setPendingKey('');
        return;
      }
      // Unknown combo, cancel
      setPendingKey('');
      return;
    }

    // i - insert mode (before cursor)
    if (key === 'i') {
      setMode('insert');
      setInsertSubMode('i');
      setMessage('-- INSERT --');
      return;
    }

    // I - insert at beginning of line
    if (key === 'I') {
      setMode('insert');
      setInsertSubMode('I');
      setCursorCol(0);
      const lineStart = lines.slice(0, cursorLine).join('\n').length + (cursorLine > 0 ? 1 : 0);
      textareaRef.current?.setSelectionRange(lineStart, lineStart);
      setMessage('-- INSERT --');
      return;
    }

    // a - insert mode (after cursor)
    if (key === 'a') {
      setMode('insert');
      setInsertSubMode('a');
      const pos = textareaRef.current?.selectionStart ?? 0;
      textareaRef.current?.setSelectionRange(pos + 1, pos + 1);
      setMessage('-- INSERT --');
      return;
    }

    // A - insert at end of line
    if (key === 'A') {
      setMode('insert');
      setInsertSubMode('A');
      const lineEnd = lines.slice(0, cursorLine).join('\n').length + (cursorLine > 0 ? 1 : 0) + lines[cursorLine].length;
      textareaRef.current?.setSelectionRange(lineEnd, lineEnd);
      setMessage('-- INSERT --');
      return;
    }

    // o - open new line below
    if (key === 'o') {
      const newLines = [...lines];
      newLines.splice(cursorLine + 1, 0, '');
      setContent(newLines.join('\n'));
      setCursorLine(cursorLine + 1);
      setCursorCol(0);
      setModified(true);
      setMode('insert');
      setInsertSubMode('o');
      setMessage('-- INSERT --');
      return;
    }

    // O - open new line above
    if (key === 'O') {
      const newLines = [...lines];
      newLines.splice(cursorLine, 0, '');
      setContent(newLines.join('\n'));
      setCursorCol(0);
      setModified(true);
      setMode('insert');
      setInsertSubMode('O');
      setMessage('-- INSERT --');
      return;
    }

    // : - command mode
    if (key === ':') {
      setCommand('');
      setMode('command');
      return;
    }

    // / - search forward
    if (key === '/') {
      setSearchQuery('');
      setMode('search');
      return;
    }

    // x - delete character
    if (key === 'x') {
      const pos = textareaRef.current?.selectionStart ?? 0;
      if (pos < content.length) {
        const newContent = content.slice(0, pos) + content.slice(pos + 1);
        setContent(newContent);
        setModified(true);
      }
      return;
    }

    // p - paste after cursor
    if (key === 'p') {
      if (yankBuffer.length > 0) {
        const newLines = [...lines];
        newLines.splice(cursorLine + 1, 0, ...yankBuffer);
        setContent(newLines.join('\n'));
        setCursorLine(cursorLine + 1);
        setModified(true);
        setMessage(`${yankBuffer.length} line(s) pasted`);
      }
      return;
    }

    // P - paste before cursor
    if (key === 'P') {
      if (yankBuffer.length > 0) {
        const newLines = [...lines];
        newLines.splice(cursorLine, 0, ...yankBuffer);
        setContent(newLines.join('\n'));
        setModified(true);
        setMessage(`${yankBuffer.length} line(s) pasted`);
      }
      return;
    }

    // d - start delete sequence (wait for d)
    if (key === 'd') {
      setPendingKey('d');
      return;
    }

    // y - start yank sequence (wait for y)
    if (key === 'y') {
      setPendingKey('y');
      return;
    }

    // g - start gg sequence
    if (key === 'g') {
      setPendingKey('g');
      return;
    }

    // G - go to last line
    if (key === 'G') {
      const lastLine = totalLines - 1;
      setCursorLine(lastLine);
      setCursorCol(0);
      return;
    }

    // u - undo (limited)
    if (key === 'u') {
      setMessage('Already at oldest change');
      return;
    }

    // Navigation
    if (key === 'h' || key === 'ArrowLeft') {
      setCursorCol(Math.max(0, cursorCol - 1));
      const pos = textareaRef.current?.selectionStart ?? 0;
      if (pos > 0) textareaRef.current?.setSelectionRange(pos - 1, pos - 1);
      return;
    }
    if (key === 'l' || key === 'ArrowRight') {
      const maxCol = (lines[cursorLine]?.length || 1) - 1;
      setCursorCol(Math.min(maxCol, cursorCol + 1));
      const pos = textareaRef.current?.selectionStart ?? 0;
      textareaRef.current?.setSelectionRange(pos + 1, pos + 1);
      return;
    }
    if (key === 'j' || key === 'ArrowDown') {
      if (cursorLine < totalLines - 1) {
        setCursorLine(cursorLine + 1);
        // Move textarea cursor
        const lineStart = lines.slice(0, cursorLine + 1).join('\n').length + 1;
        const col = Math.min(cursorCol, (lines[cursorLine + 1]?.length || 1) - 1);
        textareaRef.current?.setSelectionRange(lineStart + col, lineStart + col);
      }
      return;
    }
    if (key === 'k' || key === 'ArrowUp') {
      if (cursorLine > 0) {
        setCursorLine(cursorLine - 1);
        const lineStart = lines.slice(0, cursorLine - 1).join('\n').length + (cursorLine > 1 ? 1 : 0);
        const col = Math.min(cursorCol, (lines[cursorLine - 1]?.length || 1) - 1);
        textareaRef.current?.setSelectionRange(lineStart + col, lineStart + col);
      }
      return;
    }

    // 0 - go to beginning of line
    if (key === '0') {
      setCursorCol(0);
      const lineStart = lines.slice(0, cursorLine).join('\n').length + (cursorLine > 0 ? 1 : 0);
      textareaRef.current?.setSelectionRange(lineStart, lineStart);
      return;
    }

    // $ - go to end of line
    if (key === '$') {
      const lineLen = lines[cursorLine]?.length || 0;
      setCursorCol(Math.max(0, lineLen - 1));
      const lineStart = lines.slice(0, cursorLine).join('\n').length + (cursorLine > 0 ? 1 : 0);
      textareaRef.current?.setSelectionRange(lineStart + lineLen, lineStart + lineLen);
      return;
    }

    // w - jump to next word
    if (key === 'w') {
      const line = lines[cursorLine] || '';
      const rest = line.slice(cursorCol);
      const match = rest.match(/^\S*\s+/);
      if (match) {
        setCursorCol(cursorCol + match[0].length);
      } else if (cursorLine < totalLines - 1) {
        setCursorLine(cursorLine + 1);
        setCursorCol(0);
      }
      return;
    }

    // b - jump to previous word
    if (key === 'b') {
      const line = lines[cursorLine] || '';
      const before = line.slice(0, cursorCol);
      const match = before.match(/\s+\S*$/);
      if (match) {
        setCursorCol(cursorCol - match[0].length);
      } else if (cursorLine > 0) {
        setCursorLine(cursorLine - 1);
        setCursorCol(Math.max(0, (lines[cursorLine - 1]?.length || 1) - 1));
      }
      return;
    }

    // Escape
    if (key === 'Escape') {
      setMessage('');
      setPendingKey('');
      return;
    }
  }, [content, lines, cursorLine, cursorCol, totalLines, pendingKey, yankBuffer]);

  // Handle insert mode keys
  const handleInsertKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode('normal');
      setMessage('');
      setPendingKey('');
      // Move cursor back one in normal mode (vim behavior)
      const pos = textareaRef.current?.selectionStart ?? 0;
      if (pos > 0) {
        textareaRef.current?.setSelectionRange(pos - 1, pos - 1);
      }
      updateCursorFromTextarea();
      return;
    }
    // Let the textarea handle all other keys naturally
    setTimeout(updateCursorFromTextarea, 0);
  }, [updateCursorFromTextarea]);

  // Handle command-line keys
  const handleCommandKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeVimCommand(command);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode('normal');
      setCommand('');
      setMessage('');
    }
  }, [command, executeVimCommand]);

  // Handle search keys
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (searchQuery) {
        const startPos = lines.slice(0, cursorLine).join('\n').length + (cursorLine > 0 ? 1 : 0) + cursorCol;
        const idx = content.indexOf(searchQuery, startPos + 1);
        if (idx >= 0) {
          // Find line and col of match
          const beforeMatch = content.slice(0, idx);
          const matchLines = beforeMatch.split('\n');
          setCursorLine(matchLines.length - 1);
          setCursorCol(matchLines[matchLines.length - 1].length);
          textareaRef.current?.setSelectionRange(idx, idx + searchQuery.length);
          setMessage(`/${searchQuery}`);
        } else {
          // Wrap around
          const wrapIdx = content.indexOf(searchQuery);
          if (wrapIdx >= 0) {
            const beforeMatch = content.slice(0, wrapIdx);
            const matchLines = beforeMatch.split('\n');
            setCursorLine(matchLines.length - 1);
            setCursorCol(matchLines[matchLines.length - 1].length);
            textareaRef.current?.setSelectionRange(wrapIdx, wrapIdx + searchQuery.length);
            setMessage('search hit BOTTOM, continuing at TOP');
          } else {
            setMessage(`E486: Pattern not found: ${searchQuery}`);
          }
        }
      }
      setMode('normal');
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMode('normal');
      setMessage('');
    }
  }, [searchQuery, content, lines, cursorLine, cursorCol]);

  // Show VIM splash screen for empty new files
  const showSplash = isNewFile && content === '' && mode === 'normal';

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
      {/* ── Editor area with line numbers ── */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Line numbers gutter */}
        <div
          className="select-none overflow-hidden shrink-0 text-right pr-1"
          style={{
            backgroundColor: '#181825',
            color: '#585b70',
            minWidth: '3.5em',
            paddingTop: '2px',
            lineHeight: '1.4',
            fontSize: 'inherit',
            fontFamily: 'inherit',
          }}
        >
          {lines.map((_, i) => (
            <div
              key={i}
              style={{
                minHeight: '1.4em',
                color: i === cursorLine ? '#cdd6f4' : '#585b70',
              }}
            >
              {i + 1}
            </div>
          ))}
          {/* Tilde lines for empty space below content */}
          {Array.from({ length: Math.max(0, visibleLineCount - totalLines) }).map((_, i) => (
            <div
              key={`tilde-${i}`}
              style={{
                minHeight: '1.4em',
                color: '#45475a',
                textAlign: 'left',
                paddingLeft: '4px',
              }}
            >
              ~
            </div>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              if (mode === 'insert') {
                setContent(e.target.value);
                setModified(true);
                setTimeout(updateCursorFromTextarea, 0);
              }
            }}
            onKeyDown={mode === 'normal' ? handleNormalKey : handleInsertKey}
            onMouseUp={updateCursorFromTextarea}
            readOnly={mode !== 'insert'}
            className="absolute inset-0 w-full h-full outline-none resize-none pl-2 pt-0.5"
            style={{
              backgroundColor: '#1e1e2e',
              color: '#cdd6f4',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              lineHeight: '1.4',
              caretColor: mode === 'insert' ? '#f5e0dc' : 'transparent',
              border: 'none',
              tabSize: 8,
            }}
            spellCheck={false}
            autoComplete="off"
          />

          {/* VIM Splash screen overlay */}
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
      </div>

      {/* ── Status line (penultimate line) ── */}
      <div
        className="flex items-center justify-between px-2 shrink-0"
        style={{
          backgroundColor: '#313244',
          color: '#cdd6f4',
          minHeight: '1.4em',
          fontSize: '13px',
        }}
      >
        <span>
          {mode === 'insert' && (
            <span style={{ color: '#a6e3a1', fontWeight: 'bold' }}>-- INSERT -- </span>
          )}
          {modified && <span style={{ color: '#f38ba8' }}>[+] </span>}
          <span>{fileName}</span>
        </span>
        <span style={{ color: '#a6adc8' }}>
          {cursorLine + 1},{cursorCol + 1}
          <span className="ml-4">
            {totalLines > 0 ? Math.round(((cursorLine + 1) / totalLines) * 100) : 100}%
          </span>
        </span>
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
        {mode === 'command' ? (
          <div className="flex items-center">
            <span style={{ color: '#cdd6f4' }}>:</span>
            <input
              ref={commandRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleCommandKeyDown}
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
        ) : mode === 'search' ? (
          <div className="flex items-center">
            <span style={{ color: '#cdd6f4' }}>/</span>
            <input
              ref={searchRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
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
        ) : (
          <span style={{
            color: message.startsWith('E') ? '#f38ba8' :
              message.includes('INSERT') ? '#a6e3a1' : '#a6adc8',
          }}>
            {pendingKey ? pendingKey : message}
          </span>
        )}
      </div>
    </div>
  );
};

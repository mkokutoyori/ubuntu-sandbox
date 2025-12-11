import React, { useState, useRef, useEffect, useCallback } from 'react';
import { EditorState } from '@/terminal/types';

interface VimEditorProps {
  state: EditorState;
  onSave: (content: string, filePath: string) => void;
  onExit: () => void;
}

export const VimEditor: React.FC<VimEditorProps> = ({ state, onSave, onExit }) => {
  const [content, setContent] = useState(state.content);
  const [mode, setMode] = useState<'normal' | 'insert' | 'command'>('normal');
  const [command, setCommand] = useState('');
  const [modified, setModified] = useState(false);
  const [message, setMessage] = useState(state.message || '');
  const [cursorLine, setCursorLine] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'command') {
      commandRef.current?.focus();
    } else {
      textareaRef.current?.focus();
    }
  }, [mode]);

  const executeCommand = useCallback((cmd: string) => {
    const trimmed = cmd.trim();
    if (trimmed === 'w' || trimmed === 'write') {
      onSave(content, state.filePath);
      setMessage(`"${state.filePath}" written`);
      setModified(false);
    } else if (trimmed === 'q' || trimmed === 'quit') {
      if (modified) {
        setMessage('E37: No write since last change (add ! to override)');
      } else {
        onExit();
      }
    } else if (trimmed === 'q!' || trimmed === 'quit!') {
      onExit();
    } else if (trimmed === 'wq' || trimmed === 'x') {
      onSave(content, state.filePath);
      onExit();
    } else if (trimmed === 'wq!') {
      onSave(content, state.filePath);
      onExit();
    } else {
      setMessage(`E492: Not an editor command: ${trimmed}`);
    }
    setCommand('');
    setMode('normal');
  }, [content, state.filePath, modified, onSave, onExit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (mode === 'normal') {
      if (e.key === 'i') {
        e.preventDefault();
        setMode('insert');
        setMessage('-- INSERT --');
      } else if (e.key === 'a') {
        e.preventDefault();
        setMode('insert');
        setMessage('-- INSERT --');
      } else if (e.key === ':') {
        e.preventDefault();
        setMode('command');
        setCommand('');
      } else if (e.key === 'Escape') {
        setMessage('');
      }
    } else if (mode === 'insert') {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMode('normal');
        setMessage('');
      }
    }
  }, [mode]);

  const handleCommandKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      executeCommand(command);
    } else if (e.key === 'Escape') {
      setMode('normal');
      setCommand('');
      setMessage('');
    }
  }, [command, executeCommand]);

  const lines = content.split('\n');
  const fileName = state.filePath.split('/').pop() || '[No Name]';

  return (
    <div className="h-screen w-full bg-background flex flex-col font-mono text-sm">
      {/* Editor area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Line numbers */}
        <div className="bg-muted text-muted-foreground px-2 py-1 text-right select-none overflow-hidden">
          {lines.map((_, i) => (
            <div key={i} className="leading-5">{i + 1}</div>
          ))}
          {lines.length === 0 && <div className="leading-5">1</div>}
        </div>

        {/* Content */}
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              if (mode === 'insert') {
                setContent(e.target.value);
                setModified(true);
              }
            }}
            onKeyDown={handleKeyDown}
            readOnly={mode !== 'insert'}
            className="absolute inset-0 w-full h-full bg-background text-foreground p-1 outline-none resize-none font-mono leading-5"
            spellCheck={false}
          />
          {content.length === 0 && mode === 'normal' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground pointer-events-none">
              <div className="text-2xl mb-4">VIM - Vi IMproved</div>
              <div>version 8.2</div>
              <div className="mt-4">type :q&lt;Enter&gt; to exit</div>
              <div>type :help&lt;Enter&gt; for help</div>
            </div>
          )}
        </div>
      </div>

      {/* Status line */}
      <div className="bg-muted text-muted-foreground px-2 py-1 flex justify-between">
        <span>
          {modified && '[+] '}
          {fileName}
        </span>
        <span>{lines.length}L, {content.length}C</span>
      </div>

      {/* Command/Message line */}
      <div className="bg-background px-2 py-1 h-6">
        {mode === 'command' ? (
          <div className="flex">
            <span>:</span>
            <input
              ref={commandRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleCommandKeyDown}
              className="flex-1 bg-transparent outline-none text-foreground"
              autoFocus
            />
          </div>
        ) : (
          <span className={mode === 'insert' ? 'text-terminal-green' : 'text-foreground'}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
};

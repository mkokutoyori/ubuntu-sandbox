import React, { useState, useRef, useEffect } from 'react';
import { EditorState } from '@/terminal/types';

interface NanoEditorProps {
  state: EditorState;
  onSave: (content: string, filePath: string) => void;
  onExit: () => void;
}

export const NanoEditor: React.FC<NanoEditorProps> = ({ state, onSave, onExit }) => {
  const [content, setContent] = useState(state.content);
  const [modified, setModified] = useState(false);
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey) {
      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        onSave(content, state.filePath);
        setMessage('Wrote file');
        setModified(false);
      } else if (e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        if (modified) {
          onSave(content, state.filePath);
        }
        onExit();
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault();
        setMessage('[ line 1/1 (100%), col 1/1 (100%), char 0/0 (100%) ]');
      }
    }
  };

  const fileName = state.filePath.split('/').pop() || 'New Buffer';

  return (
    <div className="h-screen w-full bg-background flex flex-col font-mono text-sm">
      {/* Header */}
      <div className="bg-terminal-white text-background px-2 py-1 flex justify-center">
        <span>GNU nano 6.2</span>
        <span className="mx-4">{modified ? 'Modified' : ''}</span>
        <span>{fileName}</span>
      </div>

      {/* Editor */}
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => {
          setContent(e.target.value);
          setModified(true);
        }}
        onKeyDown={handleKeyDown}
        className="flex-1 w-full bg-background text-foreground p-2 outline-none resize-none font-mono"
        spellCheck={false}
      />

      {/* Message line */}
      {message && (
        <div className="text-center text-terminal-white bg-background py-1">
          {message}
        </div>
      )}

      {/* Footer shortcuts */}
      <div className="bg-background border-t border-border">
        <div className="flex flex-wrap text-xs">
          {[
            ['^G', 'Help'], ['^O', 'Write Out'], ['^W', 'Where Is'], ['^K', 'Cut'],
            ['^C', 'Location'], ['^X', 'Exit'], ['^R', 'Read File'], ['^\\ ', 'Replace'],
            ['^U', 'Paste'], ['^J', 'Justify'],
          ].map(([key, label]) => (
            <div key={key} className="flex">
              <span className="bg-terminal-white text-background px-1">{key}</span>
              <span className="text-foreground px-1">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

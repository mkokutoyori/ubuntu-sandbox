/**
 * WindowsTerminal - Windows CMD Terminal Emulation
 *
 * Uses the real WindowsPC/WindowsServer device classes directly.
 * All commands go through device.executeCommand().
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'warning';
}

interface WindowsTerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
}

let lineId = 0;

export const WindowsTerminal: React.FC<WindowsTerminalProps> = ({ device, onRequestClose }) => {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [currentPath] = useState('C:\\Users\\User');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Windows CMD prompt
  const prompt = `${currentPath}>`;

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines]);

  // Add line to output
  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setLines(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  // Execute command
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();

    // Echo command with prompt
    addLine(`${prompt}${cmd}`);

    // Handle exit
    if (trimmed.toLowerCase() === 'exit') {
      onRequestClose?.();
      setInput('');
      return;
    }

    // Add to history
    if (trimmed) {
      setHistory(prev => [...prev.slice(-199), trimmed]);
      setHistoryIndex(-1);
    }

    // Execute on device
    try {
      const result = await device.executeCommand(trimmed);

      if (result) {
        // Handle clear screen (cls)
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
          setLines([]);
        } else {
          addLine(result);
        }
      }
    } catch (err) {
      addLine(`Error: ${err}`, 'error');
    }

    setInput('');
  }, [device, prompt, addLine, onRequestClose]);

  // Keyboard handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      executeCommand(input);
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(idx);
      setInput(history[idx] || '');
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const idx = historyIndex + 1;
      if (idx >= history.length) {
        setHistoryIndex(-1);
        setInput('');
      } else {
        setHistoryIndex(idx);
        setInput(history[idx] || '');
      }
      return;
    }

    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${prompt}${input}^C`, 'warning');
      setInput('');
    }
  }, [input, history, historyIndex, prompt, addLine, executeCommand]);

  const deviceType = device.getType();
  const isServer = deviceType.includes('server');

  return (
    <div className="h-full w-full bg-[#0c0c0c] text-[#cccccc] flex flex-col font-mono text-sm">
      {/* Header */}
      <div className="border-b border-[#333333] px-3 py-2 text-xs text-[#808080] bg-[#1a1a1a]">
        {device.getHostname()} — {isServer ? 'Windows Server' : 'Windows'} Command Prompt
      </div>

      {/* Output */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 bg-[#0c0c0c]"
        onClick={() => inputRef.current?.focus()}
      >
        {/* Windows header */}
        <pre className="text-[#cccccc] whitespace-pre-wrap leading-5 mb-2">
          Microsoft Windows [Version 10.0.19045.3803]{'\n'}
          (c) Microsoft Corporation. All rights reserved.
        </pre>

        {lines.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap leading-5 ${
              line.type === 'error' ? 'text-red-400' :
              line.type === 'warning' ? 'text-yellow-400' :
              'text-[#cccccc]'
            }`}
          >
            {line.text}
          </pre>
        ))}

        {/* Input line */}
        <div className="flex items-center">
          <span className="text-[#cccccc] whitespace-pre">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none text-[#cccccc] caret-[#cccccc]"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
};

export default WindowsTerminal;

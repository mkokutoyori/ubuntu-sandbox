/**
 * WindowsTerminal - Windows CMD Terminal Emulation
 *
 * Realistic Windows Command Prompt experience:
 *   - Dynamic prompt with current working directory (updates after cd)
 *   - Tab auto-completion for commands and file paths
 *   - Command history (Up/Down arrows)
 *   - cls properly clears the terminal output
 *   - Ctrl+C interrupt, Ctrl+L clear
 *   - Windows-authentic color scheme and Cascadia Mono font
 *   - Proper scrollbar styling
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'warning' | 'prompt';
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
  const [tabSuggestions, setTabSuggestions] = useState<string[] | null>(null);
  const [currentPrompt, setCurrentPrompt] = useState('C:\\Users\\User>');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Focus on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines, tabSuggestions]);

  // Add line to output
  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setLines(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  // Refresh prompt from device (after cd, cls, etc.)
  const refreshPrompt = useCallback(async () => {
    try {
      const cdResult = await device.executeCommand('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        setCurrentPrompt(cdResult.trim() + '>');
      }
    } catch { /* ignore */ }
  }, [device]);

  // Execute command
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();

    // Clear tab suggestions
    setTabSuggestions(null);

    // Echo command with prompt
    addLine(`${currentPrompt}${cmd}`, 'prompt');

    if (!trimmed) {
      setInput('');
      return;
    }

    // Handle exit
    if (trimmed.toLowerCase() === 'exit') {
      onRequestClose?.();
      setInput('');
      return;
    }

    // Add to history
    setHistory(prev => [...prev.slice(-199), trimmed]);
    setHistoryIndex(-1);

    // Handle cls — clear terminal
    if (trimmed.toLowerCase() === 'cls') {
      setLines([]);
      setInput('');
      await refreshPrompt();
      return;
    }

    // Execute on device
    try {
      const result = await device.executeCommand(trimmed);

      if (result !== undefined && result !== null && result !== '') {
        // Split into individual lines for proper rendering
        const resultLines = result.split('\n');
        for (const line of resultLines) {
          addLine(line);
        }
      }

      // Update prompt after directory-changing commands
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('cd ') || lower.startsWith('cd\\') || lower === 'cd' || lower.startsWith('chdir')) {
        await refreshPrompt();
      }
    } catch (err) {
      addLine(`Error: ${err}`, 'error');
    }

    setInput('');
  }, [device, currentPrompt, addLine, onRequestClose, refreshPrompt]);

  // Tab completion
  const handleTab = useCallback(() => {
    if (!('getCompletions' in device) || typeof (device as any).getCompletions !== 'function') {
      return;
    }
    const completions: string[] = (device as any).getCompletions(input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
      // Single match → auto-complete
      const parts = input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        setInput(completions[0] + ' ');
      } else {
        const lastArg = parts[parts.length - 1];
        const lastSep = lastArg.lastIndexOf('\\');
        if (lastSep >= 0) {
          parts[parts.length - 1] = lastArg.substring(0, lastSep + 1) + completions[0];
        } else {
          parts[parts.length - 1] = completions[0];
        }
        setInput(parts.join(' '));
      }
      setTabSuggestions(null);
    } else {
      // Multiple matches → find common prefix
      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        while (common && !completions[i].toLowerCase().startsWith(common.toLowerCase())) {
          common = common.slice(0, -1);
        }
      }

      const parts = input.trimStart().split(/\s+/);
      const word = parts[parts.length - 1] || '';

      if (common.length > word.length) {
        if (parts.length <= 1) {
          setInput(common);
        } else {
          parts[parts.length - 1] = common;
          setInput(parts.join(' '));
        }
        setTabSuggestions(null);
      } else {
        setTabSuggestions(completions);
      }
    }
  }, [device, input]);

  // Keyboard handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Clear suggestions on non-tab keys
    if (e.key !== 'Tab') {
      setTabSuggestions(null);
    }

    if (e.key === 'Enter') {
      executeCommand(input);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      handleTab();
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

    // Ctrl+C — abort
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${currentPrompt}${input}^C`, 'warning');
      setInput('');
    }

    // Ctrl+L — clear screen (like cls)
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }

    // Escape — clear input
    if (e.key === 'Escape') {
      setInput('');
      setTabSuggestions(null);
    }
  }, [input, history, historyIndex, currentPrompt, addLine, executeCommand, handleTab]);

  return (
    <div
      className="h-full w-full flex flex-col text-sm"
      style={{
        backgroundColor: '#0c0c0c',
        color: '#cccccc',
        fontFamily: "'Cascadia Mono', 'Consolas', 'Courier New', monospace",
      }}
    >
      {/* Terminal output area */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto px-2 py-1"
        style={{
          backgroundColor: '#0c0c0c',
          lineHeight: '1.25',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {/* Windows version banner */}
        <pre
          className="whitespace-pre-wrap"
          style={{ color: '#cccccc', margin: 0, fontFamily: 'inherit', lineHeight: '1.25' }}
        >
          {'Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.'}
        </pre>
        <div style={{ height: '1.25em' }} />

        {/* Output lines */}
        {lines.map((line) => (
          <pre
            key={line.id}
            className="whitespace-pre-wrap"
            style={{
              margin: 0,
              fontFamily: 'inherit',
              lineHeight: '1.25',
              color:
                line.type === 'error' ? '#f14c4c' :
                line.type === 'warning' ? '#cca700' :
                '#cccccc',
            }}
          >
            {line.text}
          </pre>
        ))}

        {/* Tab completion suggestions */}
        {tabSuggestions && (
          <pre style={{
            margin: 0,
            fontFamily: 'inherit',
            lineHeight: '1.25',
            color: '#808080',
            paddingTop: '2px',
          }}>
            {tabSuggestions.join('  ')}
          </pre>
        )}

        {/* Active input line */}
        <div className="flex items-center" style={{ minHeight: '1.25em' }}>
          <span
            className="whitespace-pre select-none"
            style={{ color: '#cccccc', fontFamily: 'inherit' }}
          >
            {currentPrompt}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none border-none p-0 m-0"
            style={{
              color: '#cccccc',
              caretColor: '#cccccc',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              lineHeight: '1.25',
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
};

export default WindowsTerminal;

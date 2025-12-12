/**
 * DeviceTerminal - Terminal component connected to device instances
 * Uses the Sprint 1 device classes for command execution
 */

import { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { BaseDevice } from '@/devices';
import { DeviceFactory } from '@/devices/DeviceFactory';
import { cn } from '@/lib/utils';

interface DeviceTerminalProps {
  device: BaseDevice;
  className?: string;
}

interface TerminalLine {
  id: number;
  type: 'input' | 'output' | 'error';
  content: string;
}

export function DeviceTerminal({ device, className }: DeviceTerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [lineCounter, setLineCounter] = useState(0);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Get device info
  const prompt = device.getPrompt();
  const deviceType = device.getDeviceType();
  const isFullyImplemented = DeviceFactory.isFullyImplemented(deviceType);

  // Add welcome message on mount
  useEffect(() => {
    const welcomeLines: TerminalLine[] = [];
    const osType = device.getOSType();

    if (osType === 'linux') {
      welcomeLines.push(
        { id: 0, type: 'output', content: `Welcome to ${device.getName()}` },
        { id: 1, type: 'output', content: `Linux ${device.getHostname()} 5.15.0-generic` },
        { id: 2, type: 'output', content: '' },
        { id: 3, type: 'output', content: 'Type "help" for available commands.' },
        { id: 4, type: 'output', content: '' }
      );
    } else if (osType === 'cisco-ios') {
      welcomeLines.push(
        { id: 0, type: 'output', content: '' },
        { id: 1, type: 'output', content: `${device.getName()} - Cisco IOS` },
        { id: 2, type: 'output', content: '' }
      );
    } else {
      welcomeLines.push(
        { id: 0, type: 'output', content: `Connected to ${device.getName()}` },
        { id: 1, type: 'output', content: `Type "help" for available commands.` },
        { id: 2, type: 'output', content: '' }
      );
    }

    if (!isFullyImplemented) {
      welcomeLines.push(
        { id: welcomeLines.length, type: 'output', content: '\x1b[33mNote: This device type is not fully implemented yet.\x1b[0m' },
        { id: welcomeLines.length + 1, type: 'output', content: '' }
      );
    }

    setLines(welcomeLines);
    setLineCounter(welcomeLines.length);
  }, [device, isFullyImplemented]);

  // Scroll to bottom when lines change
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines]);

  // Focus input when terminal is clicked
  const handleTerminalClick = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Handle command execution
  const executeCommand = useCallback((command: string) => {
    const newLines: TerminalLine[] = [...lines];
    let nextId = lineCounter;

    // Add the command line
    newLines.push({
      id: nextId++,
      type: 'input',
      content: `${prompt}${command}`
    });

    // Execute command on the device
    const result = device.executeCommand(command);

    // Add output
    if (result.output) {
      const outputLines = result.output.split('\n');
      outputLines.forEach(line => {
        newLines.push({
          id: nextId++,
          type: 'output',
          content: line
        });
      });
    }

    // Add error if any
    if (result.error) {
      newLines.push({
        id: nextId++,
        type: 'error',
        content: result.error
      });
    }

    // Add empty line after output
    newLines.push({
      id: nextId++,
      type: 'output',
      content: ''
    });

    setLines(newLines);
    setLineCounter(nextId);

    // Add to command history
    if (command.trim()) {
      setCommandHistory(prev => [...prev, command]);
    }
    setHistoryIndex(-1);
  }, [device, lines, lineCounter, prompt]);

  // Handle key presses
  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      executeCommand(currentInput);
      setCurrentInput('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (commandHistory.length > 0) {
        const newIndex = historyIndex < commandHistory.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(newIndex);
        setCurrentInput(commandHistory[commandHistory.length - 1 - newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setCurrentInput(commandHistory[commandHistory.length - 1 - newIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setCurrentInput('');
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // TODO: Implement tab completion
    } else if (e.ctrlKey && e.key === 'c') {
      e.preventDefault();
      const newLines = [...lines];
      newLines.push({
        id: lineCounter,
        type: 'input',
        content: `${prompt}${currentInput}^C`
      });
      setLines(newLines);
      setLineCounter(lineCounter + 1);
      setCurrentInput('');
    } else if (e.ctrlKey && e.key === 'l') {
      e.preventDefault();
      setLines([]);
      setLineCounter(0);
    }
  }, [currentInput, executeCommand, commandHistory, historyIndex, lines, lineCounter, prompt]);

  // Render a line with color parsing
  const renderLine = (line: TerminalLine) => {
    // Parse ANSI color codes (basic support)
    const parseAnsi = (text: string): JSX.Element[] => {
      const parts: JSX.Element[] = [];
      let remaining = text;
      let key = 0;

      while (remaining) {
        const match = remaining.match(/\x1b\[(\d+)m/);
        if (match && match.index !== undefined) {
          // Add text before the code
          if (match.index > 0) {
            parts.push(<span key={key++}>{remaining.substring(0, match.index)}</span>);
          }
          remaining = remaining.substring(match.index + match[0].length);

          // Handle color codes
          const code = parseInt(match[1]);
          const colorMap: Record<number, string> = {
            0: '', // reset
            31: 'text-red-400',
            32: 'text-green-400',
            33: 'text-yellow-400',
            34: 'text-blue-400',
            35: 'text-purple-400',
            36: 'text-cyan-400',
            37: 'text-white'
          };

          if (code === 0) {
            // Reset - close any open spans
          } else if (colorMap[code]) {
            // Find end of colored section
            const endMatch = remaining.match(/\x1b\[0m/);
            if (endMatch && endMatch.index !== undefined) {
              parts.push(
                <span key={key++} className={colorMap[code]}>
                  {remaining.substring(0, endMatch.index)}
                </span>
              );
              remaining = remaining.substring(endMatch.index + endMatch[0].length);
            }
          }
        } else {
          // No more ANSI codes
          parts.push(<span key={key++}>{remaining}</span>);
          remaining = '';
        }
      }

      return parts.length > 0 ? parts : [<span key={0}>{text}</span>];
    };

    return (
      <div
        key={line.id}
        className={cn(
          'font-mono text-sm whitespace-pre-wrap break-all',
          line.type === 'error' ? 'text-red-400' : 'text-green-50'
        )}
      >
        {parseAnsi(line.content)}
      </div>
    );
  };

  return (
    <div
      ref={terminalRef}
      className={cn(
        'h-full overflow-y-auto bg-[#1a1b26] p-4 font-mono text-sm cursor-text',
        className
      )}
      onClick={handleTerminalClick}
    >
      {/* Terminal output */}
      {lines.map(line => renderLine(line))}

      {/* Current input line */}
      <div className="flex items-center text-green-50">
        <span className="text-green-400 whitespace-pre">{prompt}</span>
        <input
          ref={inputRef}
          type="text"
          value={currentInput}
          onChange={e => setCurrentInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent outline-none border-none text-green-50 caret-green-400"
          autoFocus
          spellCheck={false}
        />
      </div>
    </div>
  );
}

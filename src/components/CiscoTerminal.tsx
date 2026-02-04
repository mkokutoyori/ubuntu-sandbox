/**
 * CiscoTerminal - Cisco IOS Terminal Emulation
 *
 * Uses the real CiscoRouter/CiscoSwitch domain classes directly.
 * No stubs - all commands go through device.executeCommand().
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'boot';
}

interface CiscoTerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
}

let lineId = 0;

export const CiscoTerminal: React.FC<CiscoTerminalProps> = ({
  device,
  onRequestClose,
}) => {
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [isBooting, setIsBooting] = useState(true);
  const [prompt, setPrompt] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Get device info
  const deviceType = device.getType();
  const isSwitch = deviceType.includes('switch');

  // Update prompt from device
  const updatePrompt = useCallback(() => {
    if ('getPrompt' in device && typeof (device as any).getPrompt === 'function') {
      setPrompt((device as any).getPrompt());
    } else {
      setPrompt(`${device.getHostname()}>`);
    }
  }, [device]);

  // Scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output]);

  // Boot sequence on mount
  useEffect(() => {
    const boot = async () => {
      setIsBooting(true);

      // Get boot sequence from device
      let bootText = '';
      if ('getBootSequence' in device && typeof (device as any).getBootSequence === 'function') {
        bootText = (device as any).getBootSequence();
      }

      // Display boot sequence line by line
      if (bootText) {
        const lines = bootText.split('\n');
        for (const line of lines) {
          await new Promise(r => setTimeout(r, 12));
          setOutput(prev => [...prev, { id: ++lineId, text: line, type: 'boot' }]);
        }
      }

      // Show MOTD banner if available
      if ('getBanner' in device && typeof (device as any).getBanner === 'function') {
        const motd = (device as any).getBanner('motd');
        if (motd) {
          setOutput(prev => [...prev, { id: ++lineId, text: '', type: 'normal' }]);
          setOutput(prev => [...prev, { id: ++lineId, text: motd, type: 'normal' }]);
        }
      }

      setOutput(prev => [...prev, { id: ++lineId, text: '', type: 'normal' }]);
      setIsBooting(false);
      updatePrompt();
      setTimeout(() => inputRef.current?.focus(), 50);
    };

    boot();
  }, [device, updatePrompt]);

  // Add line to output
  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setOutput(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  // Execute command
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();

    // Echo command
    addLine(`${prompt}${cmd}`);

    // Add to history
    if (trimmed) {
      setHistory(prev => [...prev.slice(-99), trimmed]);
      setHistoryIndex(-1);
    }

    // Execute on device
    try {
      const result = await device.executeCommand(trimmed);

      // Check for exit/logout
      if (result === 'Connection closed.') {
        onRequestClose?.();
        return;
      }

      // Display result
      if (result) {
        addLine(result);
      }
    } catch (err) {
      addLine(`% Error: ${err}`, 'error');
    }

    // Update prompt (mode may have changed)
    updatePrompt();
    setInput('');
  }, [device, prompt, addLine, updatePrompt, onRequestClose]);

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
      addLine(`${prompt}${input}^C`);
      setInput('');
      return;
    }

    // Ctrl+Z → "end" (return to privileged EXEC)
    if (e.key === 'z' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${prompt}${input}^Z`);
      executeCommand('end');
      setInput('');
      return;
    }

    // Ctrl+A → move cursor to beginning of line
    if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      const el = inputRef.current;
      if (el) el.setSelectionRange(0, 0);
      return;
    }

    // Ctrl+E → move cursor to end of line
    if (e.key === 'e' && e.ctrlKey) {
      e.preventDefault();
      const el = inputRef.current;
      if (el) el.setSelectionRange(input.length, input.length);
      return;
    }

    // Ctrl+L → clear screen
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setOutput([]);
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      executeCommand(input + '?');
    }
  }, [input, history, historyIndex, prompt, addLine, executeCommand]);

  return (
    <div className="h-full w-full bg-black text-green-400 flex flex-col font-mono text-sm">
      {/* Header */}
      <div className="border-b border-green-900/50 px-3 py-2 text-xs text-green-600 bg-black/50">
        Cisco IOS — {device.getHostname()} ({isSwitch ? 'C2960 Switch' : 'C2911 Router'})
      </div>

      {/* Output */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 bg-black"
        onClick={() => !isBooting && inputRef.current?.focus()}
      >
        {output.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap leading-5 ${
              line.type === 'error' ? 'text-red-400' :
              line.type === 'boot' ? 'text-green-500' :
              'text-green-400'
            }`}
          >
            {line.text}
          </pre>
        ))}

        {/* Input line */}
        {!isBooting && (
          <div className="flex items-center">
            <span className="text-green-400 whitespace-pre">{prompt}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-green-400 caret-green-400"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

        {/* Boot cursor */}
        {isBooting && (
          <span className="text-green-500 animate-pulse">█</span>
        )}
      </div>
    </div>
  );
};

export default CiscoTerminal;

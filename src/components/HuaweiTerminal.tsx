/**
 * HuaweiTerminal - Huawei VRP Terminal Emulation
 *
 * Uses the real Router domain class directly via device.executeCommand().
 * Emulates the look and feel of a Huawei VRP console session.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'boot';
}

interface HuaweiTerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
}

let lineId = 0;

export const HuaweiTerminal: React.FC<HuaweiTerminalProps> = ({
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

  // Update prompt from device
  const updatePrompt = useCallback(() => {
    if ('getPrompt' in device && typeof (device as any).getPrompt === 'function') {
      setPrompt((device as any).getPrompt());
    } else {
      setPrompt(`<${device.getHostname()}>`);
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

      const bootLines = [
        '',
        'Huawei Versatile Routing Platform Software',
        `VRP (R) software, Version 8.180 (${device.getHostname()} V800R021C10SPC100)`,
        'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD.',
        '',
        'HUAWEI ' + device.getHostname() + ' uplink board starts...',
        'Loading system software...',
        'System software loaded successfully.',
        '',
        `Info: ${device.getHostname()} system is ready.`,
        '',
      ];

      for (const line of bootLines) {
        await new Promise(r => setTimeout(r, 15));
        setOutput(prev => [...prev, { id: ++lineId, text: line, type: 'boot' }]);
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
      addLine(`Error: ${err}`, 'error');
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
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      executeCommand(input + '?');
    }
  }, [input, history, historyIndex, prompt, addLine, executeCommand]);

  return (
    <div className="h-full w-full bg-[#1a1a2e] text-cyan-300 flex flex-col font-mono text-sm">
      {/* Info bar */}
      <div className="border-b border-cyan-900/50 px-3 py-1 text-xs text-cyan-600 bg-[#0f0f1e]">
        {device.getHostname()} — NE40E Router
      </div>

      {/* Output */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 bg-[#1a1a2e]"
        onClick={() => !isBooting && inputRef.current?.focus()}
      >
        {output.map((line) => (
          <pre
            key={line.id}
            className={`whitespace-pre-wrap leading-5 ${
              line.type === 'error' ? 'text-red-400' :
              line.type === 'boot' ? 'text-cyan-500' :
              'text-cyan-300'
            }`}
          >
            {line.text}
          </pre>
        ))}

        {/* Input line */}
        {!isBooting && (
          <div className="flex items-center">
            <span className="text-cyan-300 whitespace-pre">{prompt}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-cyan-300 caret-cyan-300"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

        {/* Boot cursor */}
        {isBooting && (
          <span className="text-cyan-500 animate-pulse">_</span>
        )}
      </div>
    </div>
  );
};

export default HuaweiTerminal;

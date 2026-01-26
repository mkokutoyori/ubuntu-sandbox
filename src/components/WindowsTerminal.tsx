/**
 * WindowsTerminal (stub-compatible)
 * Minimal CMD-like terminal UI using the current stubbed windows command runner.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { executeCmdCommand } from '@/terminal/windows/commands';
import { windowsFileSystem } from '@/terminal/windows/filesystem';
import { WindowsOutputLine, WindowsTerminalState } from '@/terminal/windows/types';
import { BaseDevice } from '@/domain/devices';

const generateId = () => Math.random().toString(36).slice(2);

interface WindowsTerminalProps {
  device?: BaseDevice;
  onRequestClose?: () => void;
}

export const WindowsTerminal: React.FC<WindowsTerminalProps> = ({ device, onRequestClose }) => {
  const hostname = device?.getHostname?.()?.toUpperCase() || 'DESKTOP-NETSIM';

  const [state, setState] = useState<WindowsTerminalState>(() => ({
    currentPath: 'C:\\Users\\User',
    output: [],
    commandHistory: [],
    historyIndex: -1,
    environment: {
      COMPUTERNAME: hostname,
      USERNAME: 'User',
      USERPROFILE: 'C:\\Users\\User',
    },
    shellType: 'cmd',
  }));

  const [lines, setLines] = useState<WindowsOutputLine[]>([]);
  const [input, setInput] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const prompt = useMemo(() => `${state.currentPath}>`, [state.currentPath]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [lines]);

  const append = useCallback((l: WindowsOutputLine) => setLines((p) => [...p, l]), []);

  const run = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim();

      if (trimmed === 'exit') {
        onRequestClose?.();
        if (!onRequestClose) append({ id: generateId(), text: 'exit', type: 'normal', timestamp: Date.now() });
        setInput('');
        return;
      }

      append({ id: generateId(), text: `${prompt}${cmd}`, type: 'normal', timestamp: Date.now() });

      if (trimmed) {
        setState((prev) => ({
          ...prev,
          commandHistory: [...prev.commandHistory.slice(-199), trimmed],
          historyIndex: -1,
        }));
      }

      // If a device is connected, let it handle commands (stub: string output).
      if (device) {
        const out = await device.executeCommand(trimmed);
        if (out) append({ id: generateId(), text: out, type: 'normal', timestamp: Date.now() });
        setInput('');
        return;
      }

      const result = await executeCmdCommand(trimmed, {
        currentPath: state.currentPath,
        fileSystem: windowsFileSystem,
        environment: state.environment,
      });

      if (result.output) {
        const isClear = result.output.includes('\x1b[2J') || result.output.includes('\x1b[H');
        if (isClear) {
          setLines([]);
        } else {
          append({ id: generateId(), text: result.output, type: result.exitCode === 0 ? 'normal' : 'error', timestamp: Date.now() });
        }
      }

      setState((prev) => ({
        ...prev,
        currentPath: result.newPath ?? prev.currentPath,
      }));

      setInput('');
    },
    [append, device, onRequestClose, prompt, state.currentPath, state.environment]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        run(input);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (state.commandHistory.length === 0) return;
        const newIndex = state.historyIndex === -1 ? state.commandHistory.length - 1 : Math.max(0, state.historyIndex - 1);
        setState((prev) => ({ ...prev, historyIndex: newIndex }));
        setInput(state.commandHistory[newIndex] ?? '');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (state.historyIndex === -1) return;
        const newIndex = state.historyIndex + 1;
        if (newIndex >= state.commandHistory.length) {
          setState((prev) => ({ ...prev, historyIndex: -1 }));
          setInput('');
        } else {
          setState((prev) => ({ ...prev, historyIndex: newIndex }));
          setInput(state.commandHistory[newIndex] ?? '');
        }
      }
      if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        setLines([]);
      }
      if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault();
        append({ id: generateId(), text: `${prompt}${input}^C`, type: 'warning', timestamp: Date.now() });
        setInput('');
      }
    },
    [append, input, prompt, run, state.commandHistory, state.historyIndex]
  );

  return (
    <div className="h-full w-full bg-background text-foreground flex flex-col font-mono text-sm">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        Windows CMD (stub)
      </div>
      <div ref={terminalRef} className="flex-1 overflow-auto p-3 space-y-1" onClick={() => inputRef.current?.focus()}>
        {lines.map((l) => (
          <pre
            key={l.id}
            className={l.type === 'error' ? 'text-destructive whitespace-pre-wrap' : 'whitespace-pre-wrap'}
          >
            {l.text}
          </pre>
        ))}

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground whitespace-pre">{prompt}</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
};

export default WindowsTerminal;

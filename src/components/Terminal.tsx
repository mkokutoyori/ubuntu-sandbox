/**
 * Terminal (stub-compatible)
 * Minimal Linux-like terminal UI using the current stubbed terminal/commands.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fileSystem as globalFileSystem } from '@/terminal/filesystem';
import { executeCommand } from '@/terminal/commands';
import { BaseDevice } from '@/devices';
import { OutputLine, TerminalState } from '@/terminal/types';

const generateId = () => Math.random().toString(36).slice(2);

interface TerminalProps {
  device?: BaseDevice;
  onRequestClose?: () => void;
}

export const Terminal: React.FC<TerminalProps> = ({ device, onRequestClose }) => {
  const [state, setState] = useState<TerminalState>(() => ({
    currentPath: '/home/user',
    output: [],
    commandHistory: [],
    historyIndex: -1,
    environment: {
      HOME: '/home/user',
      USER: 'user',
      PWD: '/home/user',
      HOSTNAME: device?.getHostname?.() || 'ubuntu-terminal',
      TERM: 'xterm-256color',
    },
  }));

  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const prompt = useMemo(() => {
    const user = state.environment.USER || 'user';
    const host = state.environment.HOSTNAME || 'ubuntu-terminal';
    const path = state.currentPath === state.environment.HOME ? '~' : state.currentPath;
    return `${user}@${host}:${path}$`;
  }, [state.currentPath, state.environment.HOME, state.environment.HOSTNAME, state.environment.USER]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [lines]);

  const append = useCallback((line: OutputLine) => setLines((p) => [...p, line]), []);

  const handleRun = useCallback(
    async (cmd: string) => {
      const raw = cmd;
      const trimmed = cmd.trim();

      // exit behavior
      if (trimmed === 'exit' || trimmed === 'logout') {
        onRequestClose?.();
        if (!onRequestClose) {
          append({ id: generateId(), text: 'logout', type: 'normal', timestamp: Date.now() });
        }
        setInput('');
        return;
      }

      append({ id: generateId(), text: `${prompt} ${raw}`, type: 'normal', timestamp: Date.now() });

      if (trimmed) {
        setState((prev) => ({
          ...prev,
          commandHistory: [...prev.commandHistory.slice(-199), trimmed],
          historyIndex: -1,
        }));
      }

      // If a device is connected, let it handle commands (stub: returns a string).
      if (device) {
        const out = await device.executeCommand(trimmed);
        if (out) append({ id: generateId(), text: out, type: 'normal', timestamp: Date.now() });
        setInput('');
        return;
      }

      const result = await executeCommand(trimmed, {
        currentPath: state.currentPath,
        fileSystem: globalFileSystem,
        environment: state.environment,
      });

      if (result.output) {
        append({ id: generateId(), text: result.output, type: 'normal', timestamp: Date.now() });
      }

      setState((prev) => ({
        ...prev,
        currentPath: result.newPath ?? prev.currentPath,
        environment: {
          ...prev.environment,
          PWD: result.newPath ?? prev.currentPath,
        },
      }));

      setInput('');
    },
    [append, device, onRequestClose, prompt, state.currentPath, state.environment]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleRun(input);
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
        return;
      }

      if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        setLines([]);
        return;
      }

      if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault();
        append({ id: generateId(), text: `${prompt} ${input}^C`, type: 'warning', timestamp: Date.now() });
        setInput('');
      }
    },
    [append, handleRun, input, prompt, state.commandHistory, state.historyIndex]
  );

  return (
    <div className="h-full w-full bg-background text-foreground flex flex-col font-mono text-sm">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        Linux terminal (stub)
      </div>

      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 space-y-1"
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((l) => (
          <pre
            key={l.id}
            className={
              l.type === 'error'
                ? 'text-destructive whitespace-pre-wrap'
                : l.type === 'warning'
                  ? 'text-muted-foreground whitespace-pre-wrap'
                  : 'whitespace-pre-wrap'
            }
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

export default Terminal;

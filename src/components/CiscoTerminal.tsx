/**
 * CiscoTerminal (stub-compatible)
 * Minimal Cisco CLI UI wired to the current stubbed terminal/cisco engine.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CiscoDeviceType,
  CiscoMode,
  CiscoOutputLine,
  CiscoConfig,
  generateId,
} from '@/terminal/cisco/types';
import {
  createDefaultRouterConfig,
  createDefaultSwitchConfig,
  executeCiscoCommand,
  getPrompt,
} from '@/terminal/cisco';

interface CiscoTerminalProps {
  deviceType?: CiscoDeviceType;
  hostname?: string;
  onRequestClose?: () => void;
}

export const CiscoTerminal: React.FC<CiscoTerminalProps> = ({
  deviceType = 'router',
  hostname,
  onRequestClose,
}) => {
  const config: CiscoConfig = useMemo(() => {
    const hn = hostname || (deviceType === 'switch' ? 'Switch' : 'Router');
    if (deviceType === 'switch') return createDefaultSwitchConfig(hn);
    return createDefaultRouterConfig(hn);
  }, [deviceType, hostname]);

  const [mode, setMode] = useState<CiscoMode>('user');
  const [configContext, setConfigContext] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [output, setOutput] = useState<CiscoOutputLine[]>([]);
  const [input, setInput] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [output]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const prompt = useMemo(() => getPrompt(config.hostname, mode, configContext), [config.hostname, mode, configContext]);

  const appendLine = useCallback((line: CiscoOutputLine) => {
    setOutput((prev) => [...prev, line]);
  }, []);

  const runCommand = useCallback(
    async (cmd: string) => {
      const trimmed = cmd.trim();

      // Local exit behavior (close modal if present)
      if ((trimmed === 'exit' || trimmed === 'logout') && mode === 'user') {
        onRequestClose?.();
        return;
      }

      // Echo input line
      appendLine({
        id: generateId(),
        text: `${prompt}${cmd}`,
        type: 'normal',
        timestamp: Date.now(),
      });

      if (trimmed) {
        setHistory((prev) => [...prev.slice(-99), trimmed]);
        setHistoryIndex(-1);
      }

      const result = executeCiscoCommand(trimmed, {
        mode,
        runningConfig: config,
        startupConfig: config,
        configContext,
      });

      if (result.output) {
        appendLine({
          id: generateId(),
          text: result.output,
          type: result.isError ? 'error' : 'normal',
          timestamp: Date.now(),
        });
      }

      if (result.newMode) setMode(result.newMode);
      if ('configContext' in result) setConfigContext(result.configContext);

      setInput('');
    },
    [appendLine, config, configContext, mode, onRequestClose, prompt]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        runCommand(input);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (history.length === 0) return;
        const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInput(history[newIndex] ?? '');
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex === -1) return;
        const newIndex = historyIndex + 1;
        if (newIndex >= history.length) {
          setHistoryIndex(-1);
          setInput('');
        } else {
          setHistoryIndex(newIndex);
          setInput(history[newIndex] ?? '');
        }
        return;
      }

      if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault();
        appendLine({ id: generateId(), text: `${prompt}${input}^C`, type: 'warning', timestamp: Date.now() });
        setInput('');
      }
    },
    [appendLine, history, historyIndex, input, prompt, runCommand]
  );

  return (
    <div className="h-full w-full bg-background text-foreground flex flex-col font-mono text-sm">
      <div className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
        Cisco IOS (stub) — {config.hostname}
      </div>

      <div
        ref={terminalRef}
        className="flex-1 overflow-auto p-3 space-y-1"
        onClick={() => inputRef.current?.focus()}
      >
        {output.map((line) => (
          <pre
            key={line.id}
            className={
              line.type === 'error'
                ? 'text-destructive whitespace-pre-wrap'
                : 'whitespace-pre-wrap'
            }
          >
            {line.text}
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

export default CiscoTerminal;

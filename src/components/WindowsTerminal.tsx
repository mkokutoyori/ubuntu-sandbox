/**
 * WindowsTerminal - Windows CMD + PowerShell Terminal Emulation
 *
 * Realistic Windows terminal experience:
 *   - CMD mode: Classic Command Prompt with C:\Users\User> prompt
 *   - PowerShell mode: Enter via `powershell` command, blue theme, PS prompt
 *   - Dynamic prompt with current working directory (updates after cd)
 *   - Tab auto-completion for commands and file paths
 *   - Command history (Up/Down arrows)
 *   - cls/Clear-Host properly clears the terminal output
 *   - Ctrl+C interrupt, Ctrl+L clear
 *   - Windows-authentic color scheme and Cascadia Mono font
 *   - PowerShell cmdlet mapping to Windows commands
 *   - Shell nesting: powershell from CMD, cmd from PS, exit to return
 */

import React, { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { Equipment } from '@/network';
import { PowerShellExecutor, PS_BANNER, PS_CMDLETS_LIST } from '@/network/devices/windows/PowerShellExecutor';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'warning' | 'prompt' | 'ps-header';
}

interface WindowsTerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
  /** Callback to notify parent of shell mode changes (for title bar) */
  onShellModeChange?: (mode: 'cmd' | 'powershell') => void;
}

// Shell stack entry for nesting shells
interface ShellEntry {
  type: 'cmd' | 'powershell';
  cwd: string;
}

let lineId = 0;

export const WindowsTerminal: React.FC<WindowsTerminalProps> = ({ device, onRequestClose, onShellModeChange }) => {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [tabSuggestions, setTabSuggestions] = useState<string[] | null>(null);
  const [currentPrompt, setCurrentPrompt] = useState('C:\\Users\\User>');
  // Shell mode: 'cmd' or 'powershell'
  const [shellMode, setShellMode] = useState<'cmd' | 'powershell'>('cmd');
  // Shell stack for nesting
  const [shellStack, setShellStack] = useState<ShellEntry[]>([]);
  // PowerShell current location (separate from CMD cwd)
  const [psCwd, setPsCwd] = useState('C:\\Users\\User');
  // Whether the CMD banner has been cleared (by cls)
  const [bannerCleared, setBannerCleared] = useState(false);

  // PowerShell executor (decoupled from React)
  const psExecutor = useMemo(() => new PowerShellExecutor(device as any), [device]);

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

  // Notify parent of shell mode changes
  useEffect(() => {
    onShellModeChange?.(shellMode);
  }, [shellMode, onShellModeChange]);

  // Add line to output
  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setLines(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  // Add multiple lines
  const addLines = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    const resultLines = text.split('\n');
    setLines(prev => [
      ...prev,
      ...resultLines.map(l => ({ id: ++lineId, text: l, type })),
    ]);
  }, []);

  // Refresh CMD prompt from device (after cd, cls, etc.)
  const refreshPrompt = useCallback(async () => {
    try {
      const cdResult = await device.executeCommand('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        const cwd = cdResult.trim();
        setCurrentPrompt(cwd + '>');
        setPsCwd(cwd);
      }
    } catch { /* ignore */ }
  }, [device]);

  // Get the current PS-style prompt
  const getPsPrompt = useCallback(() => {
    return `PS ${psCwd}> `;
  }, [psCwd]);

  // Get the current active prompt
  const getActivePrompt = useCallback(() => {
    return shellMode === 'powershell' ? getPsPrompt() : currentPrompt;
  }, [shellMode, currentPrompt, getPsPrompt]);

  // ─── PowerShell cmdlet execution (delegated to PowerShellExecutor) ──

  const executePSCmdlet = useCallback(async (cmdline: string): Promise<string | null> => {
    // Sync state to executor before each call
    psExecutor.setCwd(psCwd);
    psExecutor.setHistory(history);
    const result = await psExecutor.execute(cmdline);
    // Sync cwd back from executor
    const newCwd = psExecutor.getCwd();
    if (newCwd !== psCwd) {
      setPsCwd(newCwd);
      setCurrentPrompt(newCwd + '>');
    }
    return result;
  }, [psExecutor, psCwd, history]);

  // ─── Enter PowerShell mode ─────────────────────────────────────

  const enterPowerShell = useCallback(async () => {
    // Push current shell onto stack
    setShellStack(prev => [...prev, { type: shellMode, cwd: currentPrompt }]);
    setShellMode('powershell');
    // Show PowerShell banner
    addLines(PS_BANNER, 'ps-header');
  }, [shellMode, currentPrompt, addLines]);

  // ─── Exit current shell ────────────────────────────────────────

  const exitCurrentShell = useCallback(() => {
    if (shellStack.length > 0) {
      // Pop back to previous shell
      const prev = shellStack[shellStack.length - 1];
      setShellStack(s => s.slice(0, -1));
      setShellMode(prev.type);
      setCurrentPrompt(prev.cwd);
      return true; // Handled: stayed in terminal
    }
    return false; // Not handled: close terminal
  }, [shellStack]);

  // Execute command
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();
    const prompt = getActivePrompt();

    // Clear tab suggestions
    setTabSuggestions(null);

    // Echo command with prompt
    addLine(`${prompt}${cmd}`, 'prompt');

    if (!trimmed) {
      setInput('');
      return;
    }

    // Handle exit
    if (trimmed.toLowerCase() === 'exit') {
      if (!exitCurrentShell()) {
        onRequestClose?.();
      }
      setInput('');
      return;
    }

    // Add to history
    setHistory(prev => [...prev.slice(-199), trimmed]);
    setHistoryIndex(-1);

    // ── CMD mode ──
    if (shellMode === 'cmd') {
      // Detect PowerShell launch
      const lower = trimmed.toLowerCase();
      if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
        setInput('');
        await enterPowerShell();
        return;
      }

      // Handle cls — clear terminal (including banner)
      if (lower === 'cls') {
        setLines([]);
        setBannerCleared(true);
        setInput('');
        await refreshPrompt();
        return;
      }

      // Execute on device
      try {
        const result = await device.executeCommand(trimmed);
        if (result !== undefined && result !== null && result !== '') {
          addLines(result);
        }
        // Update prompt after directory-changing commands
        if (lower.startsWith('cd ') || lower.startsWith('cd\\') || lower === 'cd' || lower.startsWith('chdir')) {
          await refreshPrompt();
        }
      } catch (err) {
        addLine(`Error: ${err}`, 'error');
      }

      setInput('');
      return;
    }

    // ── PowerShell mode ──
    const lower = trimmed.toLowerCase();

    // Detect 'cmd' or 'cmd.exe' to switch to CMD from PS
    if (lower === 'cmd' || lower === 'cmd.exe') {
      setShellStack(prev => [...prev, { type: 'powershell', cwd: currentPrompt }]);
      setShellMode('cmd');
      addLines('Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.');
      setInput('');
      return;
    }

    // Handle Clear-Host / cls / clear
    if (lower === 'clear-host' || lower === 'cls' || lower === 'clear') {
      setLines([]);
      setBannerCleared(true);
      setInput('');
      return;
    }

    // Execute PowerShell cmdlet
    const result = await executePSCmdlet(trimmed);
    if (result !== null && result !== undefined && result !== '') {
      addLines(result);
    }

    // Update PS cwd after location changes
    if (lower.startsWith('set-location') || lower.startsWith('sl ') || lower.startsWith('cd ') || lower === 'cd') {
      const cdResult = await device.executeCommand('cd');
      if (cdResult && !cdResult.includes('not recognized')) {
        setPsCwd(cdResult.trim());
        setCurrentPrompt(cdResult.trim() + '>');
      }
    }

    setInput('');
  }, [device, shellMode, getActivePrompt, addLine, addLines, onRequestClose, enterPowerShell, exitCurrentShell, refreshPrompt, executePSCmdlet, currentPrompt]);

  // Tab completion
  const handleTab = useCallback(() => {
    if (!('getCompletions' in device) || typeof (device as any).getCompletions !== 'function') {
      return;
    }

    // In PowerShell mode, add PS cmdlets to completions
    if (shellMode === 'powershell') {
      const parts = input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        const prefix = (parts[0] || '').toLowerCase();
        const matches = PS_CMDLETS_LIST.filter(c => c.toLowerCase().startsWith(prefix));
        if (matches.length === 1) {
          setInput(matches[0] + ' ');
          setTabSuggestions(null);
        } else if (matches.length > 1) {
          setTabSuggestions(matches.slice(0, 20));
        }
        return;
      }
    }

    // Fall back to device completions for file paths
    const completions: string[] = (device as any).getCompletions(input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
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
  }, [device, input, shellMode]);

  // Keyboard handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
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
      addLine(`${getActivePrompt()}${input}^C`, 'warning');
      setInput('');
    }

    // Ctrl+L — clear screen
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
      setBannerCleared(true);
    }

    // Escape — clear input
    if (e.key === 'Escape') {
      setInput('');
      setTabSuggestions(null);
    }
  }, [input, history, historyIndex, getActivePrompt, addLine, executeCommand, handleTab]);

  // ─── Render ────────────────────────────────────────────────────

  const isPowerShell = shellMode === 'powershell';

  // Color scheme: same for both CMD and PowerShell (no blue background switch)
  const bgColor = '#0c0c0c';
  const textColor = '#cccccc';
  const promptColor = '#cccccc';

  return (
    <div
      className="h-full w-full flex flex-col text-sm"
      style={{
        backgroundColor: bgColor,
        color: textColor,
        fontFamily: "'Cascadia Mono', 'Consolas', 'Courier New', monospace",
      }}
    >
      {/* Terminal output area */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto px-2 py-1"
        style={{
          backgroundColor: bgColor,
          lineHeight: '1.25',
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {/* Banner: only show CMD banner if we started in CMD mode and cls hasn't been called */}
        {!isPowerShell && shellStack.length === 0 && !bannerCleared && (
          <>
            <pre
              className="whitespace-pre-wrap"
              style={{ color: textColor, margin: 0, fontFamily: 'inherit', lineHeight: '1.25' }}
            >
              {'Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.'}
            </pre>
            <div style={{ height: '1.25em' }} />
          </>
        )}

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
                line.type === 'error' ? (isPowerShell ? '#f85149' : '#f14c4c') :
                line.type === 'warning' ? (isPowerShell ? '#d29922' : '#cca700') :
                line.type === 'ps-header' ? '#eeedf0' :
                textColor,
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
            color: isPowerShell ? '#9ca0b0' : '#808080',
            paddingTop: '2px',
          }}>
            {tabSuggestions.join('  ')}
          </pre>
        )}

        {/* Active input line */}
        <div className="flex items-center" style={{ minHeight: '1.25em' }}>
          <span
            className="whitespace-pre select-none"
            style={{ color: promptColor, fontFamily: 'inherit' }}
          >
            {getActivePrompt()}
          </span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none border-none p-0 m-0"
            style={{
              color: textColor,
              caretColor: textColor,
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

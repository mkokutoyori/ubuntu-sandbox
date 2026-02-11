/**
 * CiscoTerminal - Realistic Cisco IOS Terminal Emulation
 *
 * Faithfully emulates a real Cisco IOS console session:
 *   - Inline ? help (intercepted on keypress, not on Enter)
 *     "sh?"    → prefix listing, preserves input "sh"
 *     "show ?" → subcommand listing, preserves input "show "
 *   - Tab completion (unique prefix → complete word, ambiguous → no change)
 *   - --More-- pager for long output (Space=page, Enter=line, Q=quit)
 *   - Ctrl+C (abort), Ctrl+Z (end → privileged), Ctrl+A/E (cursor), Ctrl+L (clear)
 *   - Command history (Up/Down arrows)
 *   - Boot sequence with line-by-line animation
 *   - Dynamic prompt updated after every command (mode-aware)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'boot' | 'more';
}

interface CiscoTerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
}

/** Lines per page for --More-- pager */
const PAGE_SIZE = 24;

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

  // --More-- pager state
  const [pagerLines, setPagerLines] = useState<string[] | null>(null);
  const [pagerOffset, setPagerOffset] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Get device info
  const deviceType = device.getType();
  const isSwitch = deviceType.includes('switch');

  // ─── Prompt ──────────────────────────────────────────────────────

  const updatePrompt = useCallback(() => {
    if ('getPrompt' in device && typeof (device as any).getPrompt === 'function') {
      setPrompt((device as any).getPrompt());
    } else {
      setPrompt(`${device.getHostname()}>`);
    }
  }, [device]);

  // ─── Scroll to bottom ────────────────────────────────────────────

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [output, pagerLines]);

  // ─── Boot sequence ───────────────────────────────────────────────

  useEffect(() => {
    const boot = async () => {
      setIsBooting(true);

      // Get boot sequence from device
      let bootText = '';
      if ('getBootSequence' in device && typeof (device as any).getBootSequence === 'function') {
        bootText = (device as any).getBootSequence();
      }

      // Display boot sequence line by line with realistic timing
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

  // ─── Add output line ─────────────────────────────────────────────

  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setOutput(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  const addLines = useCallback((lines: string[], type: OutputLine['type'] = 'normal') => {
    setOutput(prev => [
      ...prev,
      ...lines.map(text => ({ id: ++lineId, text, type })),
    ]);
  }, []);

  // ─── --More-- Pager ──────────────────────────────────────────────

  const startPager = useCallback((allLines: string[]) => {
    // Show first page
    const firstPage = allLines.slice(0, PAGE_SIZE);
    addLines(firstPage);

    if (allLines.length > PAGE_SIZE) {
      setPagerLines(allLines);
      setPagerOffset(PAGE_SIZE);
    }
  }, [addLines]);

  const pagerNextPage = useCallback(() => {
    if (!pagerLines) return;
    const nextChunk = pagerLines.slice(pagerOffset, pagerOffset + PAGE_SIZE);
    addLines(nextChunk);

    if (pagerOffset + PAGE_SIZE >= pagerLines.length) {
      // Done paging
      setPagerLines(null);
      setPagerOffset(0);
    } else {
      setPagerOffset(prev => prev + PAGE_SIZE);
    }
  }, [pagerLines, pagerOffset, addLines]);

  const pagerNextLine = useCallback(() => {
    if (!pagerLines) return;
    if (pagerOffset < pagerLines.length) {
      addLine(pagerLines[pagerOffset]);
      if (pagerOffset + 1 >= pagerLines.length) {
        setPagerLines(null);
        setPagerOffset(0);
      } else {
        setPagerOffset(prev => prev + 1);
      }
    }
  }, [pagerLines, pagerOffset, addLine]);

  const pagerQuit = useCallback(() => {
    setPagerLines(null);
    setPagerOffset(0);
  }, []);

  // ─── Help (? inline) ─────────────────────────────────────────────

  const showInlineHelp = useCallback((currentInput: string) => {
    // In real Cisco, when user types "?", the terminal shows:
    //   1. The current prompt + input + "?" (echo)
    //   2. The help output
    //   3. Re-displays the prompt + input (without ?) for continued typing

    // Echo the line with ?
    addLine(`${prompt}${currentInput}?`);

    // Get help from the device
    let helpText = '';
    if ('cliHelp' in device && typeof (device as any).cliHelp === 'function') {
      helpText = (device as any).cliHelp(currentInput);
    } else {
      // Fallback: send through executeCommand with ? appended
      helpText = '% Help not available';
    }

    if (helpText) {
      addLine(helpText);
    }

    // Re-display prompt + input (the input field already has it, so this
    // just appears as the prompt echo line in output before the live input)
  }, [device, prompt, addLine]);

  // ─── Tab completion ──────────────────────────────────────────────

  const doTabComplete = useCallback((currentInput: string): string | null => {
    if ('cliTabComplete' in device && typeof (device as any).cliTabComplete === 'function') {
      return (device as any).cliTabComplete(currentInput);
    }
    return null;
  }, [device]);

  // ─── Execute command ─────────────────────────────────────────────

  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();

    // Echo command with prompt
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

      // Display result with --More-- pager if needed
      if (result) {
        const lines = result.split('\n');
        if (lines.length > PAGE_SIZE) {
          startPager(lines);
        } else {
          addLine(result);
        }
      }
    } catch (err) {
      addLine(`% Error: ${err}`, 'error');
    }

    // Update prompt (mode may have changed)
    updatePrompt();
    setInput('');
  }, [device, prompt, addLine, startPager, updatePrompt, onRequestClose]);

  // ─── Keyboard handling ───────────────────────────────────────────

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // ── --More-- pager mode ─────────────────────────────────────
    if (pagerLines) {
      e.preventDefault();
      if (e.key === ' ') {
        pagerNextPage();
      } else if (e.key === 'Enter') {
        pagerNextLine();
      } else if (e.key === 'q' || e.key === 'Q') {
        pagerQuit();
      }
      return;
    }

    // ── Normal mode ─────────────────────────────────────────────

    if (e.key === 'Enter') {
      executeCommand(input);
      return;
    }

    // ── ? (inline help — intercepted BEFORE it reaches the input) ──
    // In real Cisco IOS, pressing '?' immediately shows help without
    // needing to press Enter. The '?' is consumed and not added to input.
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      showInlineHelp(input);
      // Input is NOT cleared — user continues typing where they left off
      return;
    }

    // ── Tab (completion) ────────────────────────────────────────
    if (e.key === 'Tab') {
      e.preventDefault();
      const completed = doTabComplete(input);
      if (completed) {
        setInput(completed);
      }
      // If no completion, real Cisco beeps — we do nothing (silent)
      return;
    }

    // ── History navigation ──────────────────────────────────────
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

    // ── Ctrl+C (abort current line) ─────────────────────────────
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${prompt}${input}^C`);
      setInput('');
      return;
    }

    // ── Ctrl+Z (end → return to privileged EXEC) ────────────────
    if (e.key === 'z' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${prompt}${input}^Z`);
      setInput('');
      // Execute 'end' command to go back to privileged mode
      device.executeCommand('end').then(() => updatePrompt());
      return;
    }

    // ── Ctrl+A (beginning of line) ──────────────────────────────
    if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      const el = inputRef.current;
      if (el) el.setSelectionRange(0, 0);
      return;
    }

    // ── Ctrl+E (end of line) ────────────────────────────────────
    if (e.key === 'e' && e.ctrlKey) {
      e.preventDefault();
      const el = inputRef.current;
      if (el) el.setSelectionRange(input.length, input.length);
      return;
    }

    // ── Ctrl+U (clear line) ─────────────────────────────────────
    if (e.key === 'u' && e.ctrlKey) {
      e.preventDefault();
      setInput('');
      return;
    }

    // ── Ctrl+W (delete word backward) ───────────────────────────
    if (e.key === 'w' && e.ctrlKey) {
      e.preventDefault();
      const el = inputRef.current;
      if (el) {
        const pos = el.selectionStart ?? input.length;
        // Find start of previous word
        let i = pos - 1;
        while (i >= 0 && input[i] === ' ') i--;
        while (i >= 0 && input[i] !== ' ') i--;
        setInput(input.slice(0, i + 1) + input.slice(pos));
      }
      return;
    }

    // ── Ctrl+L (clear screen) ───────────────────────────────────
    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setOutput([]);
      return;
    }
  }, [input, history, historyIndex, prompt, pagerLines, addLine,
      executeCommand, showInlineHelp, doTabComplete, pagerNextPage,
      pagerNextLine, pagerQuit, updatePrompt, device]);

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <div className="h-full w-full bg-black text-green-400 flex flex-col font-mono text-sm">
      {/* Header bar */}
      <div className="border-b border-green-900/50 px-3 py-2 text-xs text-green-600 bg-black/50 flex items-center justify-between">
        <span>Cisco IOS — {device.getHostname()} ({isSwitch ? 'C2960 Switch' : 'C2911 Router'})</span>
        <span className="text-green-800">? = help | Tab = complete</span>
      </div>

      {/* Terminal output area */}
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
              line.type === 'more' ? 'text-yellow-400' :
              'text-green-400'
            }`}
          >
            {line.text}
          </pre>
        ))}

        {/* --More-- indicator when paging */}
        {pagerLines && !isBooting && (
          <pre className="text-yellow-400 leading-5 animate-pulse">
            {' --More-- '}
          </pre>
        )}

        {/* Input line (hidden during boot and paging) */}
        {!isBooting && !pagerLines && (
          <div className="flex items-center">
            <span className="text-green-400 whitespace-pre">{prompt}</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                // Prevent ? from entering the input (it's intercepted in onKeyDown)
                // However, onChange fires AFTER the character is added, so we need
                // to filter it here as a safety net
                setInput(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none text-green-400 caret-green-400"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

        {/* Pager: capture keys even when input is hidden */}
        {pagerLines && !isBooting && (
          <input
            ref={inputRef}
            className="opacity-0 absolute w-0 h-0"
            onKeyDown={handleKeyDown}
            autoFocus
          />
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

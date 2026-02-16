/**
 * Terminal - Professional Linux Terminal Emulation
 *
 * Features:
 * - ANSI color code rendering (ls --color, etc.)
 * - Colored prompt (green user@host, blue path, like real bash)
 * - Tab auto-completion for commands and file paths
 * - Command history (Up/Down arrows)
 * - Ctrl+C interrupt, Ctrl+L clear
 * - Ubuntu terminal look & feel
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Equipment } from '@/network';
type BaseDevice = Equipment;

// ─── ANSI Color Parsing ────────────────────────────────────────────

interface StyledSpan {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
}

const ANSI_COLORS: Record<number, string> = {
  30: '#2e3436', 31: '#cc0000', 32: '#4e9a06', 33: '#c4a000',
  34: '#3465a4', 35: '#75507b', 36: '#06989a', 37: '#d3d7cf',
  90: '#555753', 91: '#ef2929', 92: '#8ae234', 93: '#fce94f',
  94: '#729fcf', 95: '#ad7fa8', 96: '#34e2e2', 97: '#eeeeec',
};
const ANSI_BG_COLORS: Record<number, string> = {
  40: '#2e3436', 41: '#cc0000', 42: '#4e9a06', 43: '#c4a000',
  44: '#3465a4', 45: '#75507b', 46: '#06989a', 47: '#d3d7cf',
  100: '#555753', 101: '#ef2929', 102: '#8ae234', 103: '#fce94f',
  104: '#729fcf', 105: '#ad7fa8', 106: '#34e2e2', 107: '#eeeeec',
};

function parseAnsi(text: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  // eslint-disable-next-line no-control-regex
  const regex = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let bold = false;
  let fg: string | undefined;
  let bg: string | undefined;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Push text before this escape
    if (match.index > lastIndex) {
      const chunk = text.slice(lastIndex, match.index);
      if (chunk) spans.push({ text: chunk, fg, bg, bold });
    }
    lastIndex = regex.lastIndex;

    // Parse SGR codes
    const codes = match[1] ? match[1].split(';').map(Number) : [0];
    for (const code of codes) {
      if (code === 0) { bold = false; fg = undefined; bg = undefined; }
      else if (code === 1) { bold = true; }
      else if (code === 22) { bold = false; }
      else if (ANSI_COLORS[code]) {
        fg = ANSI_COLORS[bold ? code + 60 : code] ?? ANSI_COLORS[code];
      }
      else if (ANSI_BG_COLORS[code]) { bg = ANSI_BG_COLORS[code]; }
    }
  }

  // Remaining text
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex), fg, bg, bold });
  }

  return spans;
}

// ─── Component ──────────────────────────────────────────────────────

interface OutputLine {
  id: number;
  text: string;
  type: 'normal' | 'error' | 'warning';
}

interface TerminalProps {
  device: BaseDevice;
  onRequestClose?: () => void;
}

let lineId = 0;

export const Terminal: React.FC<TerminalProps> = ({ device, onRequestClose }) => {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [currentPath, setCurrentPath] = useState('/home/user');
  const [tabSuggestions, setTabSuggestions] = useState<string[] | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Build prompt parts for colored rendering
  const promptParts = useMemo(() => {
    const hostname = device.getHostname() || 'localhost';
    const user = 'user';
    let path = currentPath;
    if (path === '/home/user') path = '~';
    else if (path.startsWith('/home/user/')) path = '~' + path.slice(10);
    return { user, hostname, path };
  }, [device, currentPath]);

  // Plain text prompt for history lines
  const promptText = useMemo(() =>
    `${promptParts.user}@${promptParts.hostname}:${promptParts.path}$`,
    [promptParts]
  );

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
    addLine(`${promptText} ${cmd}`);

    // Clear tab suggestions
    setTabSuggestions(null);

    // Handle exit/logout
    if (trimmed === 'exit' || trimmed === 'logout') {
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
        // Handle clear screen
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
          setLines([]);
        } else {
          addLine(result);
        }
      }

      // Sync current working directory from device (for prompt update)
      const cwd = device.getCwd();
      if (cwd) setCurrentPath(cwd);
    } catch (err) {
      addLine(`Error: ${err}`, 'error');
    }

    setInput('');
  }, [device, promptText, addLine, onRequestClose]);

  // Tab completion handler
  const handleTab = useCallback(() => {
    const completions = device.getCompletions(input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
      // Single match: complete it
      const parts = input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        setInput(completions[0] + ' ');
      } else {
        parts[parts.length - 1] = completions[0];
        setInput(parts.slice(0, -1).join(' ') + ' ' + completions[0]);
      }
      setTabSuggestions(null);
    } else {
      // Multiple matches: find common prefix and show suggestions
      const parts = input.trimStart().split(/\s+/);
      const word = parts[parts.length - 1] || '';

      // Find longest common prefix among completions
      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        while (!completions[i].startsWith(common)) {
          common = common.slice(0, -1);
        }
      }

      if (common.length > word.length) {
        // Extend input to common prefix
        if (parts.length <= 1) {
          setInput(common);
        } else {
          parts[parts.length - 1] = common;
          setInput(parts.slice(0, -1).join(' ') + ' ' + common);
        }
        setTabSuggestions(null);
      } else {
        // Show all suggestions
        setTabSuggestions(completions);
      }
    }
  }, [device, input]);

  // Keyboard handling
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      handleTab();
      return;
    }

    // Any key other than Tab clears suggestions
    if (tabSuggestions) setTabSuggestions(null);

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

    if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
      return;
    }

    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      addLine(`${promptText} ${input}^C`);
      setInput('');
    }

    if (e.key === 'a' && e.ctrlKey) {
      e.preventDefault();
      // Move cursor to beginning
      if (inputRef.current) {
        inputRef.current.setSelectionRange(0, 0);
      }
    }

    if (e.key === 'e' && e.ctrlKey) {
      e.preventDefault();
      // Move cursor to end
      if (inputRef.current) {
        inputRef.current.setSelectionRange(input.length, input.length);
      }
    }

    if (e.key === 'u' && e.ctrlKey) {
      e.preventDefault();
      setInput('');
    }
  }, [input, history, historyIndex, promptText, addLine, executeCommand, handleTab, tabSuggestions]);

  const deviceType = device.getType();
  const isServer = deviceType.includes('server');

  return (
    <div className="h-full w-full bg-[#300a24] text-[#ffffff] flex flex-col text-sm"
      style={{ fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Monaco', monospace" }}>
      {/* Title bar — Ubuntu terminal style */}
      <div className="flex items-center justify-between border-b border-[#5c3d50] px-3 py-1.5 bg-[#2c0a1f]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1.5">
            <button
              onClick={onRequestClose}
              className="w-3 h-3 rounded-full bg-[#ef5350] hover:bg-[#f44336] transition-colors"
              title="Close"
            />
            <div className="w-3 h-3 rounded-full bg-[#555753]" />
            <div className="w-3 h-3 rounded-full bg-[#555753]" />
          </div>
          <span className="text-xs text-[#c0a0b0] ml-2 select-none">
            {promptParts.user}@{promptParts.hostname}: {promptParts.path}
          </span>
        </div>
      </div>

      {/* Terminal body */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto px-3 py-2"
        style={{ backgroundColor: '#300a24', lineHeight: '1.35' }}
        onClick={() => inputRef.current?.focus()}
      >
        {lines.map((line) => (
          <div key={line.id} style={{ minHeight: '1.35em' }}>
            <AnsiLine text={line.text} type={line.type} />
          </div>
        ))}

        {/* Tab completion suggestions */}
        {tabSuggestions && (
          <div style={{ minHeight: '1.35em', color: '#d3d7cf' }}>
            {tabSuggestions.join('  ')}
          </div>
        )}

        {/* Input line with colored prompt */}
        <div className="flex items-center" style={{ minHeight: '1.35em' }}>
          <ColoredPrompt user={promptParts.user} hostname={promptParts.hostname} path={promptParts.path} />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none"
            style={{
              color: '#ffffff',
              caretColor: '#ffffff',
              fontFamily: 'inherit',
              fontSize: 'inherit',
            }}
            spellCheck={false}
            autoComplete="off"
          />
        </div>
      </div>
    </div>
  );
};

// ─── Colored Prompt Component ───────────────────────────────────────
// Renders: user@hostname:path$ with green user@host, blue path (like real bash)

const ColoredPrompt: React.FC<{ user: string; hostname: string; path: string }> = ({ user, hostname, path }) => (
  <span className="whitespace-pre select-none" style={{ fontFamily: 'inherit' }}>
    <span style={{ color: '#8ae234', fontWeight: 'bold' }}>{user}@{hostname}</span>
    <span style={{ color: '#ffffff' }}>:</span>
    <span style={{ color: '#729fcf', fontWeight: 'bold' }}>{path}</span>
    <span style={{ color: '#ffffff' }}>$ </span>
  </span>
);

// ─── ANSI Line Renderer ─────────────────────────────────────────────
// Renders a line of text with ANSI color codes as colored spans

const AnsiLine: React.FC<{ text: string; type: string }> = React.memo(({ text, type }) => {
  // Check if text has ANSI codes
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b\[/.test(text);

  if (!hasAnsi) {
    // Plain text — detect prompt pattern for coloring echoed commands
    const promptMatch = text.match(/^(\S+)@(\S+):(.+?)\$ (.*)$/);
    if (promptMatch) {
      const [, user, hostname, path, cmd] = promptMatch;
      return (
        <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
          <span style={{ color: '#8ae234', fontWeight: 'bold' }}>{user}@{hostname}</span>
          <span style={{ color: '#ffffff' }}>:</span>
          <span style={{ color: '#729fcf', fontWeight: 'bold' }}>{path}</span>
          <span style={{ color: '#ffffff' }}>$ {cmd}</span>
        </pre>
      );
    }

    return (
      <pre className="whitespace-pre-wrap" style={{
        margin: 0,
        fontFamily: 'inherit',
        color: type === 'error' ? '#ef2929' : '#d3d7cf',
      }}>
        {text}
      </pre>
    );
  }

  // Parse ANSI codes
  const spans = parseAnsi(text);
  return (
    <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
      {spans.map((span, i) => (
        <span
          key={i}
          style={{
            color: span.fg ?? '#d3d7cf',
            backgroundColor: span.bg ?? undefined,
            fontWeight: span.bold ? 'bold' : undefined,
          }}
        >
          {span.text}
        </span>
      ))}
    </pre>
  );
});

AnsiLine.displayName = 'AnsiLine';

export default Terminal;

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
 * - Interactive password prompts (sudo, su, passwd, adduser)
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
    if (match.index > lastIndex) {
      const chunk = text.slice(lastIndex, match.index);
      if (chunk) spans.push({ text: chunk, fg, bg, bold });
    }
    lastIndex = regex.lastIndex;

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

  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex), fg, bg, bold });
  }

  return spans;
}

// ─── Interactive prompt types ────────────────────────────────────────

type InteractiveStep =
  | { type: 'password'; prompt: string }
  | { type: 'output'; text: string }
  | { type: 'execute'; command: string }
  | { type: 'set-password'; username: string }
  | { type: 'adduser-info'; command: string };

interface InteractiveState {
  steps: InteractiveStep[];
  stepIndex: number;
  originalCommand: string;
  collectedPassword?: string;
  targetUser?: string;
  attemptsLeft: number;
  currentPromptText: string;
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

/**
 * Parse a command to determine what interactive steps are needed BEFORE execution.
 * Returns null if the command doesn't need interactive prompts.
 */
function buildInteractiveSteps(
  command: string,
  device: BaseDevice,
): InteractiveState | null {
  const trimmed = command.trim();
  const parts = trimmed.split(/\s+/);
  const currentUser = device.getCurrentUser();
  const currentUid = device.getCurrentUid();
  const isRoot = currentUid === 0;

  // ─── sudo commands ───────────────────────────────────────
  if (parts[0] === 'sudo' && !isRoot) {
    const subParts = parts.slice(1);
    const subCmd = subParts[0];

    // sudo passwd <user>
    if (subCmd === 'passwd' && subParts.length >= 2 && !subParts[1].startsWith('-')) {
      const targetUser = subParts[subParts.length - 1];
      return {
        steps: [
          { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
          { type: 'password', prompt: 'New password:' },
          { type: 'password', prompt: 'Retype new password:' },
          { type: 'set-password', username: targetUser },
          { type: 'output', text: 'passwd: password updated successfully' },
        ],
        stepIndex: 0,
        originalCommand: trimmed,
        attemptsLeft: 3,
        currentPromptText: `[sudo] password for ${currentUser}:`,
      };
    }

    // sudo adduser <user>
    if (subCmd === 'adduser' && subParts.length >= 2) {
      const targetUser = subParts.filter(a => !a.startsWith('-'))[0];
      return {
        steps: [
          { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
          { type: 'adduser-info', command: trimmed },
          { type: 'password', prompt: 'New password:' },
          { type: 'password', prompt: 'Retype new password:' },
          { type: 'set-password', username: targetUser },
          { type: 'output', text: 'passwd: password updated successfully' },
          { type: 'output', text: `Changing the user information for ${targetUser}` },
          { type: 'output', text: 'Enter the new value, or press ENTER for the default' },
          { type: 'output', text: '\tFull Name []: ' },
          { type: 'output', text: '\tRoom Number []: ' },
          { type: 'output', text: '\tWork Phone []: ' },
          { type: 'output', text: '\tHome Phone []: ' },
          { type: 'output', text: '\tOther []: ' },
          { type: 'output', text: 'Is the information correct? [Y/n] y' },
        ],
        stepIndex: 0,
        originalCommand: trimmed,
        attemptsLeft: 3,
        currentPromptText: `[sudo] password for ${currentUser}:`,
        targetUser,
      };
    }

    // sudo su [- username]
    if (subCmd === 'su') {
      return {
        steps: [
          { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
          { type: 'execute', command: trimmed },
        ],
        stepIndex: 0,
        originalCommand: trimmed,
        attemptsLeft: 3,
        currentPromptText: `[sudo] password for ${currentUser}:`,
      };
    }

    // Generic sudo command
    return {
      steps: [
        { type: 'password', prompt: `[sudo] password for ${currentUser}:` },
        { type: 'execute', command: trimmed },
      ],
      stepIndex: 0,
      originalCommand: trimmed,
      attemptsLeft: 3,
      currentPromptText: `[sudo] password for ${currentUser}:`,
    };
  }

  // ─── su (without sudo, non-root) ────────────────────────
  if (parts[0] === 'su' && !isRoot) {
    // Determine target user for password check
    let targetUser = 'root';
    for (const p of parts.slice(1)) {
      if (p !== '-' && p !== '-l' && p !== '--login' && !p.startsWith('-')) {
        targetUser = p;
      }
    }
    return {
      steps: [
        { type: 'password', prompt: 'Password:' },
        { type: 'execute', command: trimmed },
      ],
      stepIndex: 0,
      originalCommand: trimmed,
      targetUser,
      attemptsLeft: 3,
      currentPromptText: 'Password:',
    };
  }

  // ─── passwd (own password change, non-root) ─────────────
  if (parts[0] === 'passwd' && parts.length === 1 && !isRoot) {
    return {
      steps: [
        { type: 'output', text: `Changing password for ${currentUser}.` },
        { type: 'password', prompt: 'Current password:' },
        { type: 'password', prompt: 'New password:' },
        { type: 'password', prompt: 'Retype new password:' },
        { type: 'set-password', username: currentUser },
        { type: 'output', text: 'passwd: password updated successfully' },
      ],
      stepIndex: 0,
      originalCommand: trimmed,
      attemptsLeft: 3,
      currentPromptText: '',
    };
  }

  return null; // No interactive prompts needed
}

export const Terminal: React.FC<TerminalProps> = ({ device, onRequestClose }) => {
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [currentPath, setCurrentPath] = useState(() => device.getCwd() || '/home/user');
  const [currentUser, setCurrentUser] = useState(() => device.getCurrentUser() || 'user');
  const [tabSuggestions, setTabSuggestions] = useState<string[] | null>(null);
  const [interactive, setInteractive] = useState<InteractiveState | null>(null);
  const [passwordBuf, setPasswordBuf] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  const isPasswordMode = interactive !== null &&
    interactive.stepIndex < interactive.steps.length &&
    interactive.steps[interactive.stepIndex].type === 'password';

  // Build prompt parts for colored rendering
  const promptParts = useMemo(() => {
    const hostname = device.getHostname() || 'localhost';
    const user = currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return { user, hostname, path, promptChar };
  }, [device, currentPath, currentUser]);

  // Plain text prompt for history lines
  const promptText = useMemo(() =>
    `${promptParts.user}@${promptParts.hostname}:${promptParts.path}${promptParts.promptChar}`,
    [promptParts]
  );

  // Focus on mount
  useEffect(() => {
    if (isPasswordMode) {
      hiddenInputRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
  }, [isPasswordMode]);

  // Scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines, interactive]);

  // Add line to output
  const addLine = useCallback((text: string, type: OutputLine['type'] = 'normal') => {
    setLines(prev => [...prev, { id: ++lineId, text, type }]);
  }, []);

  // Sync device state to prompt
  const syncDeviceState = useCallback(() => {
    const cwd = device.getCwd();
    if (cwd) setCurrentPath(cwd);
    setCurrentUser(device.getCurrentUser());
  }, [device]);

  // Process the interactive steps after password is validated
  const processInteractiveSteps = useCallback(async (state: InteractiveState) => {
    let idx = state.stepIndex;
    while (idx < state.steps.length) {
      const step = state.steps[idx];

      if (step.type === 'password') {
        // Need user input — pause here
        setInteractive({ ...state, stepIndex: idx, currentPromptText: step.prompt });
        addLine(step.prompt);
        return;
      }

      if (step.type === 'output') {
        addLine(step.text);
        idx++;
        continue;
      }

      if (step.type === 'execute') {
        try {
          const result = await device.executeCommand(step.command);
          if (result) {
            if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
              setLines([]);
            } else {
              addLine(result);
            }
          }
        } catch (err) {
          addLine(`Error: ${err}`, 'error');
        }
        syncDeviceState();
        idx++;
        continue;
      }

      if (step.type === 'set-password') {
        if (state.collectedPassword) {
          device.setUserPassword(step.username, state.collectedPassword);
        }
        idx++;
        continue;
      }

      if (step.type === 'adduser-info') {
        // Execute the adduser command (creates user + home + skeleton)
        try {
          const result = await device.executeCommand(step.command);
          if (result) addLine(result);
        } catch (err) {
          addLine(`Error: ${err}`, 'error');
        }
        idx++;
        continue;
      }

      idx++;
    }

    // All steps done
    syncDeviceState();
    setInteractive(null);
    setPasswordBuf('');
  }, [device, addLine, syncDeviceState]);

  // Handle password submission
  const handlePasswordSubmit = useCallback(async (password: string) => {
    if (!interactive) return;
    const step = interactive.steps[interactive.stepIndex] as { type: 'password'; prompt: string };

    // Determine what kind of password prompt this is
    const isSudoPrompt = step.prompt.startsWith('[sudo]');
    const isSuPrompt = step.prompt === 'Password:' && interactive.originalCommand.startsWith('su');
    const isCurrentPassword = step.prompt === 'Current password:';
    const isNewPassword = step.prompt === 'New password:';
    const isRetypePassword = step.prompt === 'Retype new password:';

    if (isSudoPrompt) {
      // Validate current user's password
      const currentUser = device.getCurrentUser();
      if (!device.checkPassword(currentUser, password)) {
        const left = interactive.attemptsLeft - 1;
        if (left <= 0) {
          addLine('sudo: 3 incorrect password attempts');
          setInteractive(null);
          setPasswordBuf('');
          return;
        }
        addLine('Sorry, try again.');
        addLine(step.prompt);
        setInteractive({ ...interactive, attemptsLeft: left });
        setPasswordBuf('');
        return;
      }
      // Password correct — advance to next step
      const newState = { ...interactive, stepIndex: interactive.stepIndex + 1 };
      setPasswordBuf('');
      processInteractiveSteps(newState);
      return;
    }

    if (isSuPrompt) {
      // Validate target user's password
      const targetUser = interactive.targetUser || 'root';
      if (!device.checkPassword(targetUser, password)) {
        addLine('su: Authentication failure');
        setInteractive(null);
        setPasswordBuf('');
        return;
      }
      // Password correct — advance to next step (execute su)
      const newState = { ...interactive, stepIndex: interactive.stepIndex + 1 };
      setPasswordBuf('');
      processInteractiveSteps(newState);
      return;
    }

    if (isCurrentPassword) {
      // Validate current user's current password
      const currentUser = device.getCurrentUser();
      if (!device.checkPassword(currentUser, password)) {
        addLine('passwd: Authentication token manipulation error');
        addLine('passwd: password unchanged');
        setInteractive(null);
        setPasswordBuf('');
        return;
      }
      const newState = { ...interactive, stepIndex: interactive.stepIndex + 1 };
      setPasswordBuf('');
      processInteractiveSteps(newState);
      return;
    }

    if (isNewPassword) {
      // Store the new password for verification
      const newState = {
        ...interactive,
        stepIndex: interactive.stepIndex + 1,
        collectedPassword: password,
      };
      setPasswordBuf('');
      processInteractiveSteps(newState);
      return;
    }

    if (isRetypePassword) {
      // Verify password match
      if (password !== interactive.collectedPassword) {
        addLine('Sorry, passwords do not match.');
        addLine('passwd: Authentication token manipulation error');
        addLine('passwd: password unchanged');
        setInteractive(null);
        setPasswordBuf('');
        return;
      }
      // Passwords match — advance
      const newState = { ...interactive, stepIndex: interactive.stepIndex + 1 };
      setPasswordBuf('');
      processInteractiveSteps(newState);
      return;
    }
  }, [interactive, device, addLine, processInteractiveSteps]);

  // Execute command
  const executeCommand = useCallback(async (cmd: string) => {
    const trimmed = cmd.trim();

    // Echo command with prompt
    addLine(`${promptText} ${cmd}`);

    // Clear tab suggestions
    setTabSuggestions(null);

    // Handle exit/logout — check if in su session first
    if (trimmed === 'exit' || trimmed === 'logout') {
      const exitResult = device.handleExit();
      if (exitResult.inSu) {
        if (exitResult.output) addLine(exitResult.output);
        syncDeviceState();
        setInput('');
        return;
      }
      onRequestClose?.();
      setInput('');
      return;
    }

    // Add to history
    if (trimmed) {
      setHistory(prev => [...prev.slice(-199), trimmed]);
      setHistoryIndex(-1);
    }

    // Check if this command needs interactive prompts
    const interactiveState = buildInteractiveSteps(trimmed, device);
    if (interactiveState) {
      setInput('');
      setPasswordBuf('');
      processInteractiveSteps(interactiveState);
      return;
    }

    // Execute on device directly (no interactive prompts needed)
    try {
      const result = await device.executeCommand(trimmed);

      if (result) {
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
          setLines([]);
        } else {
          addLine(result);
        }
      }

      syncDeviceState();
    } catch (err) {
      addLine(`Error: ${err}`, 'error');
    }

    setInput('');
  }, [device, promptText, addLine, onRequestClose, syncDeviceState, processInteractiveSteps]);

  // Tab completion handler
  const handleTab = useCallback(() => {
    const completions = device.getCompletions(input);
    if (completions.length === 0) return;

    if (completions.length === 1) {
      const parts = input.trimStart().split(/\s+/);
      if (parts.length <= 1) {
        setInput(completions[0] + ' ');
      } else {
        parts[parts.length - 1] = completions[0];
        setInput(parts.slice(0, -1).join(' ') + ' ' + completions[0]);
      }
      setTabSuggestions(null);
    } else {
      const parts = input.trimStart().split(/\s+/);
      const word = parts[parts.length - 1] || '';

      let common = completions[0];
      for (let i = 1; i < completions.length; i++) {
        while (!completions[i].startsWith(common)) {
          common = common.slice(0, -1);
        }
      }

      if (common.length > word.length) {
        if (parts.length <= 1) {
          setInput(common);
        } else {
          parts[parts.length - 1] = common;
          setInput(parts.slice(0, -1).join(' ') + ' ' + common);
        }
        setTabSuggestions(null);
      } else {
        setTabSuggestions(completions);
      }
    }
  }, [device, input]);

  // Keyboard handling for normal mode
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      handleTab();
      return;
    }

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
      if (inputRef.current) {
        inputRef.current.setSelectionRange(0, 0);
      }
    }

    if (e.key === 'e' && e.ctrlKey) {
      e.preventDefault();
      if (inputRef.current) {
        inputRef.current.setSelectionRange(input.length, input.length);
      }
    }

    if (e.key === 'u' && e.ctrlKey) {
      e.preventDefault();
      setInput('');
    }
  }, [input, history, historyIndex, promptText, addLine, executeCommand, handleTab, tabSuggestions]);

  // Keyboard handling for password mode
  const handlePasswordKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const pw = passwordBuf;
      setPasswordBuf('');
      handlePasswordSubmit(pw);
      return;
    }

    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      setInteractive(null);
      setPasswordBuf('');
      addLine('^C');
    }
  }, [passwordBuf, handlePasswordSubmit, addLine]);

  const deviceType = device.getType();

  return (
    <div className="h-full w-full bg-[#300a24] text-[#ffffff] flex flex-col text-sm"
      style={{ fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Monaco', monospace" }}>
      {/* Terminal info bar */}
      <div className="flex items-center border-b border-[#5c3d50] px-3 py-1 bg-[#2c0a1f]">
        <span className="text-xs text-[#c0a0b0] select-none">
          {promptParts.user}@{promptParts.hostname}: {promptParts.path}
        </span>
      </div>

      {/* Terminal body */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto px-3 py-2"
        style={{ backgroundColor: '#300a24', lineHeight: '1.35' }}
        onClick={() => {
          if (isPasswordMode) {
            hiddenInputRef.current?.focus();
          } else {
            inputRef.current?.focus();
          }
        }}
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

        {/* Password input line (hidden characters, like real sudo/su) */}
        {isPasswordMode && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            <input
              ref={hiddenInputRef}
              type="password"
              value={passwordBuf}
              onChange={(e) => setPasswordBuf(e.target.value)}
              onKeyDown={handlePasswordKeyDown}
              className="absolute opacity-0 w-0 h-0"
              style={{ position: 'absolute', left: '-9999px' }}
              autoComplete="off"
              autoFocus
            />
            {/* Blinking cursor to show we're waiting for input */}
            <span className="animate-pulse" style={{ color: '#ffffff' }}>&#9608;</span>
          </div>
        )}

        {/* Normal input line with colored prompt */}
        {!isPasswordMode && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            <ColoredPrompt user={promptParts.user} hostname={promptParts.hostname} path={promptParts.path} promptChar={promptParts.promptChar} />
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
        )}
      </div>
    </div>
  );
};

// ─── Colored Prompt Component ───────────────────────────────────────

const ColoredPrompt: React.FC<{ user: string; hostname: string; path: string; promptChar?: string }> = ({ user, hostname, path, promptChar = '$' }) => (
  <span className="whitespace-pre select-none" style={{ fontFamily: 'inherit' }}>
    <span style={{ color: user === 'root' ? '#ef2929' : '#8ae234', fontWeight: 'bold' }}>{user}@{hostname}</span>
    <span style={{ color: '#ffffff' }}>:</span>
    <span style={{ color: '#729fcf', fontWeight: 'bold' }}>{path}</span>
    <span style={{ color: '#ffffff' }}>{promptChar} </span>
  </span>
);

// ─── ANSI Line Renderer ─────────────────────────────────────────────

const AnsiLine: React.FC<{ text: string; type: string }> = React.memo(({ text, type }) => {
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b\[/.test(text);

  if (!hasAnsi) {
    const promptMatch = text.match(/^(\S+)@(\S+):(.+?)([$#]) (.*)$/);
    if (promptMatch) {
      const [, user, hostname, path, char, cmd] = promptMatch;
      return (
        <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
          <span style={{ color: user === 'root' ? '#ef2929' : '#8ae234', fontWeight: 'bold' }}>{user}@{hostname}</span>
          <span style={{ color: '#ffffff' }}>:</span>
          <span style={{ color: '#729fcf', fontWeight: 'bold' }}>{path}</span>
          <span style={{ color: '#ffffff' }}>{char} {cmd}</span>
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

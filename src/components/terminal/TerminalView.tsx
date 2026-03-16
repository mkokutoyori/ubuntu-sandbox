/**
 * TerminalView — Unified terminal UI component.
 *
 * Subscribes to a TerminalSession model and renders the appropriate
 * UI based on the session type (linux, cisco, huawei, windows).
 *
 * This component is intentionally thin: ALL state lives in the session
 * model, making the terminal survive React mount/unmount cycles.
 */

import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { VimEditor } from '@/components/editors/VimEditor';
import type { TerminalSession, OutputLine, InputMode, TerminalTheme } from '@/terminal/sessions/TerminalSession';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { CLITerminalSession } from '@/terminal/sessions/CLITerminalSession';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';

// ─── ANSI Color Parsing (extracted from old Terminal.tsx) ─────────

interface StyledSpan { text: string; fg?: string; bg?: string; bold?: boolean; }

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
  let lastIndex = 0; let bold = false; let fg: string | undefined; let bg: string | undefined;
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
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (ANSI_COLORS[code]) fg = ANSI_COLORS[bold ? code + 60 : code] ?? ANSI_COLORS[code];
      else if (ANSI_BG_COLORS[code]) bg = ANSI_BG_COLORS[code];
    }
  }
  if (lastIndex < text.length) spans.push({ text: text.slice(lastIndex), fg, bg, bold });
  return spans;
}

// ─── Hook: subscribe to a session's state changes ─────────────────

export function useTerminalSession(session: TerminalSession): number {
  return useSyncExternalStore(session.subscribe, session.getVersion);
}

// ─── Main Component ───────────────────────────────────────────────

interface TerminalViewProps {
  session: TerminalSession;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ session }) => {
  // Subscribe to session changes — triggers re-render on every notify()
  useTerminalSession(session);

  const theme = session.getTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const interactiveInputRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on output changes
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  });

  // Focus management
  useEffect(() => {
    const mode = session.inputMode;
    if (mode.type === 'password') hiddenInputRef.current?.focus();
    else if (mode.type === 'interactive-text') interactiveInputRef.current?.focus();
    else if (mode.type === 'normal') {
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [session.inputMode.type]);

  // Focus input on click
  const handleClick = useCallback(() => {
    const mode = session.inputMode;
    if (mode.type === 'password') hiddenInputRef.current?.focus();
    else if (mode.type === 'interactive-text') interactiveInputRef.current?.focus();
    else if (mode.type === 'booting') return;
    else inputRef.current?.focus();
  }, [session.inputMode]);

  // Key handler bridge — converts React event to session KeyEvent
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const consumed = session.handleKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
    if (consumed) e.preventDefault();
  }, [session]);

  // ── Editor overlay (Linux only) ─────────────────────────────────
  if (session.inputMode.type === 'editor') {
    const editorMode = session.inputMode;
    const linuxSession = session as LinuxTerminalSession;
    if (editorMode.editorType === 'nano') {
      return (
        <div className="h-full w-full flex flex-col">
          <NanoEditor
            filePath={editorMode.absolutePath}
            initialContent={editorMode.content}
            isNewFile={editorMode.isNewFile}
            onSave={(content: string, path: string) => linuxSession.editorSave(content, path)}
            onExit={() => linuxSession.editorExit()}
          />
        </div>
      );
    }
    return (
      <div className="h-full w-full flex flex-col">
        <VimEditor
          filePath={editorMode.absolutePath}
          initialContent={editorMode.content}
          isNewFile={editorMode.isNewFile}
          editorName={editorMode.editorType === 'vi' ? 'vi' : 'vim'}
          onSave={(content: string, path: string) => linuxSession.editorSave(content, path)}
          onExit={() => linuxSession.editorExit()}
        />
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────

  const sessionType = session.getSessionType();
  const inputMode = sessionType === 'linux'
    ? (session as LinuxTerminalSession).currentInputMode
    : session.inputMode;
  const isPasswordMode = inputMode.type === 'password';
  const isInteractiveText = inputMode.type === 'interactive-text';
  const isBooting = inputMode.type === 'booting';
  const isPager = inputMode.type === 'pager';

  return (
    <div
      className="h-full w-full flex flex-col text-sm"
      style={{
        backgroundColor: theme.backgroundColor,
        color: theme.textColor,
        fontFamily: theme.fontFamily,
      }}
    >
      {/* ── Info bar (linux, cisco, huawei) ── */}
      {sessionType !== 'windows' && (
        <InfoBar theme={theme} session={session} />
      )}

      {/* ── Windows CMD banner ── */}
      {sessionType === 'windows' && !(session as WindowsTerminalSession).bannerCleared
        && (session as WindowsTerminalSession).shellMode === 'cmd'
        && (session as WindowsTerminalSession).shellStack.length === 0 && (
        <>
          <div className="px-2 py-1">
            <pre className="whitespace-pre-wrap" style={{ color: theme.textColor, margin: 0, fontFamily: 'inherit', lineHeight: '1.25' }}>
              {'Microsoft Windows [Version 10.0.22631.6649]\n(c) Microsoft Corporation. All rights reserved.'}
            </pre>
            <div style={{ height: '1.25em' }} />
          </div>
        </>
      )}

      {/* ── Terminal output ── */}
      <div
        ref={terminalRef}
        className="flex-1 overflow-auto px-3 py-2"
        style={{ backgroundColor: theme.backgroundColor, lineHeight: sessionType === 'windows' ? '1.25' : '1.35' }}
        onClick={handleClick}
      >
        {session.lines.map((line) => (
          <LineRenderer key={line.id} line={line} theme={theme} sessionType={sessionType} />
        ))}

        {/* Tab suggestions (linux, windows) */}
        {sessionType === 'linux' && (session as LinuxTerminalSession).tabSuggestions && (
          <div style={{ minHeight: '1.35em', color: '#d3d7cf' }}>
            {(session as LinuxTerminalSession).tabSuggestions!.join('  ')}
          </div>
        )}
        {sessionType === 'windows' && (session as WindowsTerminalSession).tabSuggestions && (
          <pre style={{ margin: 0, fontFamily: 'inherit', lineHeight: '1.25', color: '#808080', paddingTop: '2px' }}>
            {(session as WindowsTerminalSession).tabSuggestions!.join('  ')}
          </pre>
        )}

        {/* Pager indicator (cisco, huawei) */}
        {isPager && (
          <pre className="animate-pulse" style={{ color: theme.pagerColor || '#facc15', lineHeight: '1.35' }}>
            {(inputMode as { indicator: string }).indicator}
          </pre>
        )}

        {/* Password input (linux) */}
        {isPasswordMode && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            <input
              ref={hiddenInputRef}
              type="password"
              value={(session as LinuxTerminalSession).getPasswordBuf()}
              onChange={(e) => (session as LinuxTerminalSession).setPasswordBuf(e.target.value)}
              onKeyDown={handleKeyDown}
              className="absolute opacity-0 w-0 h-0"
              style={{ position: 'absolute', left: '-9999px' }}
              autoComplete="off"
              autoFocus
            />
            <span className="animate-pulse" style={{ color: theme.textColor }}>&#9608;</span>
          </div>
        )}

        {/* Interactive text input (linux) */}
        {isInteractiveText && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            <input
              ref={interactiveInputRef}
              type="text"
              value={(session as LinuxTerminalSession).getInputBuf()}
              onChange={(e) => (session as LinuxTerminalSession).setInputBuf(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none"
              style={{ color: theme.textColor, caretColor: theme.textColor, fontFamily: 'inherit', fontSize: 'inherit' }}
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </div>
        )}

        {/* Normal input line */}
        {!isPasswordMode && !isInteractiveText && !isBooting && !isPager && (
          <div className="flex items-center" style={{ minHeight: sessionType === 'windows' ? '1.25em' : '1.35em' }}>
            <PromptRenderer session={session} sessionType={sessionType} theme={theme} />
            <input
              ref={inputRef}
              value={session.input}
              onChange={(e) => {
                session.setInput(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent outline-none border-none p-0 m-0"
              style={{ color: theme.textColor, caretColor: theme.textColor, fontFamily: 'inherit', fontSize: 'inherit' }}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

        {/* Pager hidden input (captures keys) */}
        {isPager && !isBooting && (
          <input
            ref={inputRef}
            className="opacity-0 absolute w-0 h-0"
            onKeyDown={handleKeyDown}
            autoFocus
          />
        )}

        {/* Boot cursor */}
        {isBooting && (
          <span className="animate-pulse" style={{ color: theme.bootColor || theme.textColor }}>
            {sessionType === 'huawei' ? '_' : '█'}
          </span>
        )}
      </div>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────

/** Info bar at the top of the terminal */
const InfoBar: React.FC<{ theme: TerminalTheme; session: TerminalSession }> = ({ theme, session }) => {
  const info = session.getInfoBarContent();
  return (
    <div
      className="flex items-center justify-between px-3 py-1 text-xs select-none shrink-0"
      style={{
        backgroundColor: theme.infoBarBg,
        color: theme.infoBarText,
        borderBottom: `1px solid ${theme.infoBarBorder}`,
      }}
    >
      <span>{info.left}</span>
      {info.right && <span style={{ fontSize: '10px', opacity: 0.6 }}>{info.right}</span>}
    </div>
  );
};

/** Render a prompt appropriate to the session type */
const PromptRenderer: React.FC<{ session: TerminalSession; sessionType: string; theme: TerminalTheme }> = ({ session, sessionType, theme }) => {
  if (sessionType === 'linux') {
    const linux = session as LinuxTerminalSession;
    const p = linux.getPromptParts();
    return (
      <span className="whitespace-pre select-none" style={{ fontFamily: 'inherit' }}>
        <span style={{ color: p.user === 'root' ? '#ef2929' : '#8ae234', fontWeight: 'bold' }}>{p.user}@{p.hostname}</span>
        <span style={{ color: '#ffffff' }}>:</span>
        <span style={{ color: '#729fcf', fontWeight: 'bold' }}>{p.path}</span>
        <span style={{ color: '#ffffff' }}>{p.promptChar} </span>
      </span>
    );
  }

  // Cisco, Huawei, Windows — simple text prompt
  return (
    <span className="whitespace-pre select-none" style={{ color: theme.promptColor, fontFamily: 'inherit' }}>
      {session.getPrompt()}
    </span>
  );
};

/** Render a single output line */
const LineRenderer: React.FC<{ line: OutputLine; theme: TerminalTheme; sessionType: string }> = React.memo(({ line, theme, sessionType }) => {
  // Linux: ANSI color support
  if (sessionType === 'linux') {
    return <LinuxLineRenderer line={line} theme={theme} />;
  }

  // Cisco/Huawei
  if (sessionType === 'cisco' || sessionType === 'huawei') {
    let color = theme.textColor;
    if (line.type === 'error') color = theme.errorColor;
    else if (line.type === 'boot') color = theme.bootColor || theme.textColor;
    else if (line.type === 'more') color = theme.pagerColor || '#facc15';
    return <pre className="whitespace-pre-wrap leading-5" style={{ color, margin: 0, fontFamily: 'inherit' }}>{line.text}</pre>;
  }

  // Windows
  let color = theme.textColor;
  if (line.type === 'error') color = theme.errorColor;
  else if (line.type === 'warning') color = theme.warningColor || '#cca700';
  else if (line.type === 'ps-header') color = '#eeedf0';
  return <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit', lineHeight: '1.25', color }}>{line.text}</pre>;
});
LineRenderer.displayName = 'LineRenderer';

/** Linux line renderer with ANSI color + colored prompt detection */
const LinuxLineRenderer: React.FC<{ line: OutputLine; theme: TerminalTheme }> = React.memo(({ line, theme }) => {
  const text = line.text;
  // eslint-disable-next-line no-control-regex
  const hasAnsi = /\x1b\[/.test(text);

  if (!hasAnsi) {
    // Detect prompt pattern for colored rendering in history
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
        margin: 0, fontFamily: 'inherit',
        color: line.type === 'error' ? theme.errorColor : '#d3d7cf',
      }}>
        {text}
      </pre>
    );
  }

  const spans = parseAnsi(text);
  return (
    <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
      {spans.map((span, i) => (
        <span key={i} style={{
          color: span.fg ?? '#d3d7cf',
          backgroundColor: span.bg ?? undefined,
          fontWeight: span.bold ? 'bold' : undefined,
        }}>{span.text}</span>
      ))}
    </pre>
  );
});
LinuxLineRenderer.displayName = 'LinuxLineRenderer';

export default TerminalView;

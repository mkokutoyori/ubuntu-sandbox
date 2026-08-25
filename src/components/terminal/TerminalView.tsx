/**
 * TerminalView — Unified terminal UI component.
 *
 * Subscribes to a TerminalSession model and renders the appropriate
 * UI based on the session type (linux, cisco, huawei, windows).
 *
 * This component is intentionally thin: ALL state lives in the session
 * model, making the terminal survive React mount/unmount cycles.
 *
 * Features:
 *   - Reverse history search (Ctrl+R) with inline search bar
 *   - Copy/Paste (Ctrl+Shift+C / Ctrl+Shift+V)
 *   - Recording indicator
 *   - ANSI color parsing
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { VimEditor } from '@/components/editors/VimEditor';
import type {
  RemoteNanoController,
  RemoteVimController,
} from '@/terminal/editors/RemoteEditorController';
import type { TerminalSession, OutputLine, InputMode, TerminalTheme } from '@/terminal/sessions/TerminalSession';
import type { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { WindowsTerminalSession } from '@/terminal/sessions/WindowsTerminalSession';
import { parseAnsiToSegments, stripAnsi } from '@/terminal/core/OutputFormatter';
import {
  applyLineEdit, lineEditActionFor, movesCaretOnly,
} from '@/terminal/core/lineEditing';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';

// ─── Hook: subscribe to a session's state changes ─────────────────

export function useTerminalSession(session: TerminalSession): number {
  return useSyncExternalStore(session.subscribe, session.getVersion);
}

// ─── Clipboard helpers ───────────────────────────────────────────

async function copySelectionToClipboard(): Promise<boolean> {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  try {
    await navigator.clipboard.writeText(selection.toString());
    return true;
  } catch {
    return false;
  }
}

async function pasteFromClipboard(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
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
  const pendingCaret = useRef<{ at: number; element: HTMLInputElement } | null>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const interactiveInputRef = useRef<HTMLInputElement>(null);
  const reverseSearchRef = useRef<HTMLInputElement>(null);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on output changes — but only while the user hasn't
  // scrolled up to read earlier output. A real terminal freezes the view
  // when you scroll back; forcing scrollTop unconditionally on every
  // render (as this used to) yanked the view back down on every notify
  // during a stream (tail -f, ping, debug ip ospf), making the
  // scrollback unreadable (rapport 09 audit — mirrors the live-tail
  // pattern already correct in NetworkLogsPanel.tsx).
  const [stuckToBottom, setStuckToBottom] = useState(true);
  useEffect(() => {
    if (stuckToBottom && terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  });

  const handleTerminalScroll = useCallback(() => {
    const el = terminalRef.current;
    if (!el) return;
    // Small epsilon: fractional scroll positions (momentum scroll,
    // sub-pixel rendering) can land a px or two short of the true max.
    setStuckToBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 4);
  }, []);

  // Focus management — use currentInputMode (polymorphic) for all session types.
  // This stays in sync with the rendering logic which also reads currentInputMode.
  const effectiveMode = session.currentInputMode;
  // A foreground stream (tail -f, tcpdump, …) swaps in the hidden capture
  // input below. Tracked as a dependency (not just read inline) so the
  // focus effect only re-runs when this actually flips, not on every
  // streamed line — see the ref on that input for why that distinction matters.
  const hasAttachedStream = (session.listAttachedStreams?.().length ?? 0) > 0;

  useEffect(() => {
    if (effectiveMode.type === 'password') {
      setTimeout(() => hiddenInputRef.current?.focus({ preventScroll: true }), 10);
    } else if (effectiveMode.type === 'interactive-text') {
      setTimeout(() => interactiveInputRef.current?.focus(), 10);
    } else if (effectiveMode.type === 'reverse-search') {
      setTimeout(() => reverseSearchRef.current?.focus(), 30);
    } else if (effectiveMode.type === 'pager') {
      inputRef.current?.focus({ preventScroll: true });
    } else if (effectiveMode.type === 'normal' && hasAttachedStream) {
      inputRef.current?.focus({ preventScroll: true });
    } else if (effectiveMode.type === 'normal') {
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [effectiveMode.type, hasAttachedStream]);

  useEffect(() => {
    const wanted = pendingCaret.current;
    if (wanted === null) return;
    pendingCaret.current = null;
    wanted.element.setSelectionRange(wanted.at, wanted.at);
  });

  // Focus input on click — use effectiveMode for consistency with rendering
  const handleClick = useCallback(() => {
    if (effectiveMode.type === 'password') hiddenInputRef.current?.focus({ preventScroll: true });
    else if (effectiveMode.type === 'interactive-text') interactiveInputRef.current?.focus();
    else if (effectiveMode.type === 'reverse-search') reverseSearchRef.current?.focus();
    else if (effectiveMode.type === 'booting') return;
    else inputRef.current?.focus();
  }, [effectiveMode]);

  // Key handler bridge — converts React event to session KeyEvent
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const element = e.currentTarget;
    const edits = element.name === 'terminalInput' || element.name === 'terminalPrompt';
    const action = edits ? lineEditActionFor({
      key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey,
      metaKey: e.metaKey, shiftKey: e.shiftKey,
    }) : null;
    if (action === 'history-prev' || action === 'history-next') {
      e.preventDefault();
      session.handleKey({
        key: action === 'history-prev' ? 'ArrowUp' : 'ArrowDown',
        ctrlKey: false, altKey: false, metaKey: false, shiftKey: false,
      });
      return;
    }
    if (action !== null && !(action === 'delete' && element.value.length === 0)) {
      e.preventDefault();
      const edited = applyLineEdit(action, element.value, element.selectionStart ?? 0);
      if (movesCaretOnly(action)) {
        element.setSelectionRange(edited.caret, edited.caret);
        return;
      }
      pendingCaret.current = { at: edited.caret, element };
      if (element.name === 'terminalPrompt') session.setInputBuf(edited.text);
      else session.setInput(edited.text);
      return;
    }

    // Ctrl+Shift+C → copy selection
    if (e.key === 'C' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      copySelectionToClipboard();
      return;
    }

    // Ctrl+Shift+V → paste from clipboard (multi-line aware)
    if (e.key === 'V' && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      pasteFromClipboard().then(text => {
        if (text) session.pasteText(text);
      });
      return;
    }

    // Ctrl+C pendant un collage : l'interrompre AVANT que la touche ne
    // parte au shell. Un bloc collé par erreur doit pouvoir être arrêté,
    // et c'est le geste que tout le monde fait.
    if (e.key === 'c' && e.ctrlKey && !e.shiftKey && session.abortPaste()) {
      e.preventDefault();
      return;
    }

    // ArrowRight at end-of-input accepts the ghost suggestion inline.
    if (e.key === 'ArrowRight' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const el = e.currentTarget;
      const atEnd = el.selectionStart === el.value.length
        && el.selectionEnd === el.value.length;
      if (atEnd && session.getGhostSuggestion() && session.acceptGhost()) {
        e.preventDefault();
        return;
      }
    }

    const consumed = session.handleKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
    });
    if (consumed) e.preventDefault();
  }, [session]);

  // Native paste (Ctrl+V / middle-click / context menu) — the single-line
  // <input> silently drops embedded newlines, so intercept the paste event
  // and route the raw clipboard text through the multi-line paste handler.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (text.includes('\n') || text.includes('\r')) {
      e.preventDefault();
      session.pasteText(text);
    }
  }, [session]);

  // Les champs sans valeur contrôlée — pager, capture de flux — ne
  // voient jamais passer un `onChange`, donc un collage y était
  // intégralement perdu, y compris sur une seule ligne. Ils routent
  // TOUT vers la session.
  const handlePasteRaw = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    if (text) session.pasteText(text);
  }, [session]);

  // Global keydown for copy/paste when terminal div is focused but no input has focus
  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      if (e.key === 'C' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        copySelectionToClipboard();
      }
      if (e.key === 'V' && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        pasteFromClipboard().then(text => {
          if (text) session.pasteText(text);
        });
      }
    };

    el.addEventListener('keydown', handler);
    return () => el.removeEventListener('keydown', handler);
  }, [session]);

  // An editor whose buffer lives on the remote: the very same overlays,
  // driven by a proxy over the SSH channel instead of a local engine
  // (docs/PRD-SSH-Unification.md §4bis B3).
  if (session.currentInputMode.type === 'remote-editor') {
    const remote = session.currentInputMode;
    const done = () => session.foreground.editorExit(remote.controller.savedOnExit);
    return (
      <div className="h-full w-full flex flex-col">
        {remote.editorType === 'nano' ? (
          <NanoEditor
            filePath={remote.filePath}
            initialContent=""
            isNewFile={remote.controller.isNewFile}
            driver={remote.controller as RemoteNanoController}
            onExit={done}
          />
        ) : (
          <VimEditor
            filePath={remote.filePath}
            initialContent=""
            isNewFile={remote.controller.isNewFile}
            editorName={remote.editorType === 'vi' ? 'vi' : 'vim'}
            driver={remote.controller as RemoteVimController}
            onExit={done}
          />
        )}
      </div>
    );
  }

  if (session.currentInputMode.type === 'editor') {
    const editorMode = session.currentInputMode;
    // The editing device is whichever session is actually driving the
    // overlay — for a plain terminal that's `session` itself, but over an
    // SSH hop (or any nested child session) it's `session.foreground`,
    // the same session `currentInputMode`/`editorSave`/`editorExit` above
    // already delegate to (LinuxTerminalSession/WindowsTerminalSession
    // `currentInputMode` overrides both forward to `foreground`).
    const linuxSession = session.foreground as LinuxTerminalSession;
    const linuxDevice = linuxSession.device as LinuxMachine;
    const fsContext = new LinuxEditorFsContext(linuxDevice, linuxSession.shell ?? undefined);
    const owner = linuxSession.shell?.user ?? linuxDevice.getCurrentUser();
    if (editorMode.editorType === 'nano') {
      return (
        <div className="h-full w-full flex flex-col">
          <NanoEditor
            filePath={editorMode.absolutePath}
            initialContent={editorMode.content}
            isNewFile={editorMode.isNewFile}
            readOnly={editorMode.readOnly}
            showPosition={editorMode.showPosition}
            showLineNumbers={editorMode.showLineNumbers}
            initialCursorLine={editorMode.initialCursorLine}
            initialCursorCol={editorMode.initialCursorCol}
            fsContext={fsContext}
            onExit={(saved: boolean) => session.editorExit(saved)}
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
          initialCursorLine={editorMode.initialCursorLine}
          fsContext={fsContext}
          owner={owner}
          onExit={(saved: boolean) => session.editorExit(saved)}
        />
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────

  const sessionType = session.getSessionType();
  const inputMode = session.currentInputMode;
  const isPasswordMode = inputMode.type === 'password';
  const isInteractiveText = inputMode.type === 'interactive-text';
  const isBooting = inputMode.type === 'booting';
  const isPager = inputMode.type === 'pager';
  const isReverseSearch = session.inputMode.type === 'reverse-search';
  const isDisconnected = inputMode.type === 'disconnected';

  return (
    <div
      className="h-full w-full flex flex-col text-sm"
      style={{
        backgroundColor: theme.backgroundColor,
        color: theme.textColor,
        fontFamily: theme.fontFamily,
      }}
      tabIndex={0}
    >
      {/* ── Info bar (linux, cisco, huawei) ── */}
      {sessionType !== 'windows' && (
        <InfoBar theme={theme} session={session} />
      )}

      {/* ── SSH context banner (BRD SSH-04) ── */}
      {sessionType === 'linux' && (
        <SshContextBanner theme={theme} session={session} />
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
        data-testid="terminal-output"
        className="flex-1 overflow-auto px-3 py-2"
        style={{ backgroundColor: theme.backgroundColor, lineHeight: sessionType === 'windows' ? '1.25' : '1.35' }}
        onClick={handleClick}
        onScroll={handleTerminalScroll}
      >
        {session.lines.map((line) => (
          // content-visibility: auto skips layout/paint for scrollback that
          // isn't near the viewport — scrollback is configurable up to
          // 50,000 lines (rapport 09 audit), and without this every past
          // line stays a live DOM/layout node forever. contain-intrinsic-size
          // is a single-row estimate (most lines are); a wrapped long line
          // gets its real height once it scrolls into view, same trade-off
          // MDN documents for long chat/log lists.
          <div
            key={line.id}
            style={{ contentVisibility: 'auto', containIntrinsicSize: `0 ${sessionType === 'windows' ? '1.25em' : '1.35em'}` }}
          >
            <LineRenderer line={line} theme={theme} sessionType={sessionType} />
          </div>
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

        {/* Password input (all session types) */}
        {isPasswordMode && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            <input
              ref={hiddenInputRef}
              name="terminalPassword"
              type="password"
              autoComplete="off"
              aria-label={(inputMode as { promptText?: string }).promptText ?? 'Password'}
              value={session.getPasswordBuf()}
              onChange={(e) => session.setPasswordBuf(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              className="overflow-hidden"
              style={{
                // `fixed` (not `absolute`) deliberately: this input sits
                // inside a long scrollable output list. Typing into it
                // moves its native caret, and Chromium reveals a moving
                // caret by scrolling every ancestor up to and including
                // `overflow:hidden` ones that were never meant to scroll
                // (see TerminalModal's wrapper around this component) —
                // `preventScroll` on focus() doesn't cover that, only the
                // initial focus. `fixed` positioning takes it out of the
                // scrollable-ancestor chain entirely, so there is nothing
                // left for the browser to scroll to "reveal" it.
                position: 'fixed',
                top: 0,
                left: 0,
                width: '1px',
                height: '1px',
                padding: 0,
                margin: '-1px',
                clip: 'rect(0, 0, 0, 0)',
                whiteSpace: 'nowrap',
                borderWidth: 0,
              }}
            />
            {(inputMode as { promptText?: string }).promptText && (
              <span style={{ color: theme.textColor, whiteSpace: 'pre' }}>
                {(inputMode as { promptText?: string }).promptText}
              </span>
            )}
            <span className="animate-pulse" style={{ color: theme.textColor }}>&#9608;</span>
          </div>
        )}

        {/* Interactive text input (GECOS, SQL*Plus, Cisco/Huawei confirmations) */}
        {isInteractiveText && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            {(inputMode as { promptText: string }).promptText && (
              <span style={{ color: theme.textColor, whiteSpace: 'pre' }}>
                {(inputMode as { promptText: string }).promptText}
              </span>
            )}
            <input
              ref={interactiveInputRef}
              name="terminalPrompt"
              type="text"
              autoComplete="off"
              value={session.getInputBuf()}
              onChange={(e) => session.setInputBuf(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              className="flex-1 bg-transparent outline-none border-none p-0 m-0"
              style={{ color: theme.textColor, caretColor: theme.textColor, fontFamily: 'inherit', fontSize: 'inherit' }}
              spellCheck={false}
              autoFocus
            />
          </div>
        )}

        {/* Disconnected — read-only line, no cursor */}
        {isDisconnected && (
          <div className="flex items-center" style={{ minHeight: '1.35em' }}>
            <span style={{ color: theme.errorColor, fontStyle: 'italic' }}>
              [session frozen — {(inputMode as { reason: string }).reason} — close this window or power the device back on]
            </span>
          </div>
        )}

        {/* Hidden capture input while a foreground stream (e.g. `tail -f`)
            holds the tty — the prompt stays invisible but Ctrl+C still
            reaches the session. Focusing happens in the effect above, keyed
            off `hasAttachedStream` — NOT in this ref callback: an inline
            arrow function ref re-runs on every render (i.e. on every
            streamed line), which was stealing focus from other terminals
            on each new packet/line even when the user had since clicked
            elsewhere. */}
        {!isDisconnected && !isPasswordMode && !isInteractiveText && !isBooting && !isPager && !isReverseSearch
          && hasAttachedStream && (
          <input
            ref={inputRef}
            name="terminalStreamCapture"
            type="text"
            autoComplete="off"
            aria-hidden="true"
            tabIndex={-1}
            className="opacity-0 absolute w-0 h-0"
            onKeyDown={handleKeyDown}
            onPaste={handlePasteRaw}
          />
        )}

        {/* Normal input line — hidden while a foreground stream holds the tty. */}
        {!isDisconnected && !isPasswordMode && !isInteractiveText && !isBooting && !isPager && !isReverseSearch
          && !hasAttachedStream && (
          <div className="flex items-center" style={{ minHeight: sessionType === 'windows' ? '1.25em' : '1.35em' }}>
            <PromptRenderer session={session} sessionType={sessionType} theme={theme} />
            <div className="relative flex-1">
              {session.getGhostSuggestion() && (
                <div
                  aria-hidden
                  className="absolute inset-0 pointer-events-none whitespace-pre overflow-hidden"
                  style={{ fontFamily: 'inherit', fontSize: 'inherit' }}
                >
                  <span style={{ visibility: 'hidden' }}>{session.input}</span>
                  <span data-testid="ghost-suggestion" style={{ color: '#6b7280' }}>
                    {session.getGhostSuggestion()}
                  </span>
                </div>
              )}
              <input
                ref={inputRef}
                name="terminalInput"
                type="text"
                autoComplete="off"
                aria-label={`Command line — ${session.getInfoBarContent().left}`}
                value={session.input}
                onChange={(e) => {
                  session.setInput(e.target.value);
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                className="w-full bg-transparent outline-none border-none p-0 m-0"
                style={{ color: theme.textColor, caretColor: theme.textColor, fontFamily: 'inherit', fontSize: 'inherit' }}
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {/* Pager hidden input (captures keys). Focusing happens in the
            effect above (keyed off `effectiveMode.type`), not in this ref
            callback — same reasoning as the stream-capture input. */}
        {isPager && !isBooting && (
          <input
            ref={inputRef}
            name="terminalPagerCapture"
            autoComplete="off"
            aria-hidden="true"
            tabIndex={-1}
            className="opacity-0 absolute w-0 h-0"
            onKeyDown={handleKeyDown}
            onPaste={handlePasteRaw}
          />
        )}

        {/* Boot cursor */}
        {isBooting && (
          <span className="animate-pulse" style={{ color: theme.bootColor || theme.textColor }}>
            {sessionType === 'huawei' ? '_' : '█'}
          </span>
        )}
      </div>

      {/* ── Reverse search bar (bash Ctrl+R) ── */}
      {isReverseSearch && (
        <ReverseSearchBar
          session={session}
          theme={theme}
          inputRef={reverseSearchRef}
          onKeyDown={handleKeyDown}
        />
      )}

      {/* ── Recording indicator ── */}
      {session.isRecording && (
        <div
          className="flex items-center gap-1.5 px-3 py-0.5 text-xs shrink-0 select-none"
          style={{ backgroundColor: 'rgba(220, 38, 38, 0.15)', borderTop: '1px solid rgba(220, 38, 38, 0.3)' }}
        >
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span style={{ color: '#fca5a5' }}>Recording</span>
        </div>
      )}
    </div>
  );
};

// ─── Sub-components ───────────────────────────────────────────────

/**
 * SSH context banner — shown only when the terminal has been pushed
 * into a remote machine via `ssh user@host`. Renders the connection
 * chain so the user sees clearly that the prompt + tab-completion now
 * mirror the remote even though the local terminal is still the host
 * window. BRD SSH-04 follow-up.
 */
const SshContextBanner: React.FC<{
  theme: TerminalTheme;
  session: TerminalSession;
}> = ({ theme, session }) => {
  const ctx = session.getSshContextInfo();
  if (!ctx.active) return null;
  const trail = ctx.chain
    .map((f) => `${f.user}@${f.host}`)
    .join(' › ');
  return (
    <div
      className="flex items-center justify-between px-3 py-1 text-xs select-none shrink-0"
      style={{
        backgroundColor: '#0c4a6e', // sky-900
        color: '#e0f2fe', // sky-100
        borderBottom: `1px solid ${theme.infoBarBorder}`,
        fontFamily: theme.fontFamily,
      }}
      data-testid="ssh-context-banner"
    >
      <span>
        <span aria-hidden style={{ marginRight: '0.5em' }}>🔒</span>
        SSH session — {trail}
      </span>
      <span style={{ fontSize: '10px', opacity: 0.7 }}>
        type `exit` or `logout` to disconnect
      </span>
    </div>
  );
};

/** Info bar at the top of the terminal */
export const InfoBar: React.FC<{ theme: TerminalTheme; session: TerminalSession }> = ({ theme, session }) => {
  const info = session.getInfoBarContent();
  const bgJobs = session.listAsyncJobs().filter((j) => j.mode === 'background' && j.running);
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
      <span className="flex items-center gap-3">
        {bgJobs.length > 0 && (
          <span className="flex items-center gap-1" style={{ fontSize: '10px', color: theme.pagerColor || '#facc15' }}>
            <span className="animate-pulse">●</span>
            {bgJobs.length === 1 ? bgJobs[0].label : `${bgJobs.length} background tasks`}
          </span>
        )}
        {info.right && <span style={{ fontSize: '10px', opacity: 0.6 }}>{info.right}</span>}
      </span>
    </div>
  );
};

/** Reverse search bar — appears at the bottom of the terminal */
const ReverseSearchBar: React.FC<{
  session: TerminalSession;
  theme: TerminalTheme;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}> = ({ session, theme, inputRef, onKeyDown }) => {
  const query = session.reverseSearchQuery;
  const match = session.reverseSearchMatch;

  return (
    <div
      className="flex items-center px-3 py-1 text-sm shrink-0"
      style={{
        backgroundColor: theme.infoBarBg,
        borderTop: `1px solid ${theme.infoBarBorder}`,
        fontFamily: theme.fontFamily,
      }}
    >
      <span style={{ color: '#facc15', whiteSpace: 'pre' }}>(reverse-i-search)`</span>
      <input
        ref={inputRef}
        name="terminalReverseSearch"
        autoComplete="off"
        value={query}
        onChange={(e) => session.updateReverseSearch(e.target.value)}
        onKeyDown={onKeyDown}
        className="bg-transparent outline-none border-none p-0 m-0"
        style={{
          color: theme.textColor,
          caretColor: theme.textColor,
          fontFamily: 'inherit',
          fontSize: 'inherit',
          minWidth: '20px',
          width: `${Math.max(1, query.length)}ch`,
        }}
        spellCheck={false}
        autoFocus
      />
      <span style={{ color: '#facc15', whiteSpace: 'pre' }}>': </span>
      <span style={{ color: match ? theme.textColor : '#ef2929', opacity: match ? 1 : 0.6 }}>
        {match ?? (query ? 'no match' : '')}
      </span>
    </div>
  );
};

/** Render a prompt appropriate to the session type */
const PromptRenderer: React.FC<{ session: TerminalSession; sessionType: string; theme: TerminalTheme }> = ({ session, sessionType, theme }) => {
  if (sessionType === 'linux') {
    const p = session.getPromptParts();
    // Foreign sub-shell (SSH'd into Windows / Cisco / Huawei, sqlplus,
    // sftp, …): the bash-style `user@host:path$` decomposition does not
    // apply. Render the sub-shell's raw prompt verbatim so cmd shows
    // `C:\Users\carl>`, PS shows `PS C:\Users\carl>`, IOS shows `R1#`, etc.
    if (p.foreign) {
      return (
        <span className="whitespace-pre select-none" style={{ color: theme.promptColor, fontFamily: 'inherit' }}>
          {session.getPrompt()}
        </span>
      );
    }
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

/** Render a single output line — exported for unit tests. */
export const LineRenderer: React.FC<{ line: OutputLine; theme: TerminalTheme; sessionType: string }> = React.memo(({ line, theme, sessionType }) => {
  if (line.promptText !== undefined) {
    const linuxPromptMatch = sessionType === 'linux'
      ? line.promptText.match(/^(\S+)@(\S+):(.+?)([$#])\s*$/)
      : null;
    if (linuxPromptMatch) {
      const [, user, hostname, path, char] = linuxPromptMatch;
      return (
        <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
          <span style={{ color: user === 'root' ? '#ef2929' : '#8ae234', fontWeight: 'bold' }}>{user}@{hostname}</span>
          <span style={{ color: '#ffffff' }}>:</span>
          <span style={{ color: '#729fcf', fontWeight: 'bold' }}>{path}</span>
          <span style={{ color: '#ffffff' }}>{char} </span>
          <span style={{ color: theme.textColor }}>{line.text}</span>
        </pre>
      );
    }
    return (
      <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
        <span style={{ color: theme.promptColor }}>{line.promptText}</span>
        <span style={{ color: theme.textColor }}>{line.text}</span>
      </pre>
    );
  }

  // Pre-styled segments take precedence — the shell that produced the
  // line already decided how it should look (used by SSH push to keep
  // ANSI rendering correct on a Windows host, etc.). Render verbatim.
  if (line.segments && line.segments.length > 0) {
    return (
      <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
        {line.segments.map((seg, i) => (
          <span key={i} style={{
            color: seg.style?.color ?? theme.textColor,
            backgroundColor: seg.style?.backgroundColor ?? undefined,
            fontWeight: seg.style?.bold ? 'bold' : undefined,
            fontStyle: seg.style?.italic ? 'italic' : undefined,
            textDecoration: seg.style?.underline ? 'underline' : undefined,
            opacity: seg.style?.dim ? 0.6 : undefined,
          }}>{seg.text}</span>
        ))}
      </pre>
    );
  }

  if (sessionType === 'linux') {
    return <LinuxLineRenderer line={line} theme={theme} />;
  }

  if (sessionType === 'cisco' || sessionType === 'huawei') {
    let color = theme.textColor;
    if (line.type === 'error') color = theme.errorColor;
    else if (line.type === 'boot') color = theme.bootColor || theme.textColor;
    else if (line.type === 'more') color = theme.pagerColor || '#facc15';
    return <pre className="whitespace-pre-wrap leading-5" style={{ color, margin: 0, fontFamily: 'inherit' }}>{stripAnsi(line.text)}</pre>;
  }

  let color = theme.textColor;
  if (line.type === 'error') color = theme.errorColor;
  else if (line.type === 'warning') color = theme.warningColor || '#cca700';
  else if (line.type === 'ps-header') color = '#eeedf0';
  return <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit', lineHeight: '1.25', color }}>{stripAnsi(line.text)}</pre>;
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

  const segments = parseAnsiToSegments(text);
  return (
    <pre className="whitespace-pre-wrap" style={{ margin: 0, fontFamily: 'inherit' }}>
      {segments.map((seg, i) => (
        <span key={i} style={{
          color: seg.style?.color ?? '#d3d7cf',
          backgroundColor: seg.style?.backgroundColor ?? undefined,
          fontWeight: seg.style?.bold ? 'bold' : undefined,
        }}>{seg.text}</span>
      ))}
    </pre>
  );
});
LinuxLineRenderer.displayName = 'LinuxLineRenderer';

export default TerminalView;

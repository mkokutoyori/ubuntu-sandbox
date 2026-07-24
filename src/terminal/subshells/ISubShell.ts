/**
 * ISubShell — Interface for interactive sub-shells that run inside
 * a terminal session (e.g. SQL*Plus, PowerShell, psql, python REPL).
 *
 * A sub-shell takes over the terminal input until the user exits.
 * The owning session routes keyboard events and line input to it.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';
import type { RichOutputLine } from '@/terminal/core/types';
import type { IShellBase } from '@/shell/IShellBase';
import type { IShell, PendingInputDirective } from '@/shell/IShell';

export interface SubShellResult {
  /** Lines to display in the terminal. */
  output: string[];
  /**
   * Pre-styled output lines. When present, the host session renders these
   * segments verbatim (bypassing its own vendor renderer). Provided by
   * sub-shells that own their styling, e.g. an SSH-pushed bash whose
   * `ls --color` ANSI codes must NOT be interpreted by the Windows host.
   */
  styledOutput?: RichOutputLine[];
  /** Whether the sub-shell has exited. */
  exit: boolean;
  /** The prompt to show for the next line of input. */
  prompt: string;
  /** Whether the terminal screen should be cleared before showing output. */
  clearScreen?: boolean;
  /**
   * When set, the host terminal must put the user into the corresponding
   * input mode (password masking, plain text prompt) and route the value
   * collected after Enter to `handleInput` on the sub-shell.
   */
  pendingInput?: PendingInputDirective;
  /**
   * When set, the host terminal pushes this `IShell` as the new active
   * sub-shell (e.g. an interactive `ssh`/`sudo -i` handled inside another
   * sub-shell's own `handleInput`, not the top-level `processLine` path).
   */
  childShell?: IShell;
}

/**
 * The legacy per-terminal sub-shell contract. It extends `IShellBase` so
 * every sub-shell in the project — old or new — shares the same root
 * identity (`kind`, `connection`, `getPrompt`, `dispose`).
 */
export interface ISubShell extends IShellBase {
  /** Current prompt string (e.g. "SQL> ", "PS C:\> "). */
  getPrompt(): string;

  /**
   * Handle a key event. Returns true if consumed, false to let
   * the view handle it (e.g. typing into the input field).
   */
  handleKey(e: KeyEvent): boolean;

  /**
   * Process a completed line of input (after Enter).
   * Returns output to display and whether the sub-shell has exited.
   * May be sync or async (e.g. PowerShell network commands are async).
   *
   * @param onProgress Optional. When provided, a sub-shell whose command
   * streams output over time (e.g. a real-wire `ping` over an SSH shell
   * channel) MAY call this repeatedly with one line of text at a time
   * *before* its returned promise settles, instead of batching everything
   * into the final `SubShellResult.output`. Sub-shells that don't stream
   * simply ignore the parameter — the host always renders `output` too.
   */
  processLine(
    line: string,
    onProgress?: (text: string) => void,
  ): SubShellResult | Promise<SubShellResult>;

  /**
   * Optional: interrupt (Ctrl+C) the sub-shell's currently in-flight
   * `processLine()` call, e.g. to stop a remote streaming job over the
   * wire. Returns true if something was actually interrupted — the host
   * then leaves its own "^C" echo to the sub-shell's own output instead
   * of printing its own. Sub-shells without a cancellable in-flight
   * command omit this; the host falls back to its default local-only
   * "clear input, echo ^C" behaviour.
   */
  interruptForeground?(): boolean;

  /**
   * Tab-completion candidates for the current input line. The owning
   * session decides how to apply them (single match → complete inline,
   * many → list). Optional: sub-shells without completion can omit it.
   * Implementations return the full candidate token(s), not just the
   * suffix, so the session's completion controller can diff.
   */
  getCompletions?(line: string): string[];

  /**
   * Continuation hook: after the host terminal collects the value
   * requested by a `pendingInput` directive, it calls this method with
   * the user's input. Sub-shells that never request pendingInput can
   * omit it; the host treats absence as "no continuation".
   */
  handleInput?(value: string): SubShellResult | Promise<SubShellResult>;

  /** Clean up resources when the sub-shell exits. */
  dispose(): void;
}

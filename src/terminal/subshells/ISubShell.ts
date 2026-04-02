/**
 * ISubShell — Interface for interactive sub-shells that run inside
 * a terminal session (e.g. SQL*Plus, PowerShell, psql, python REPL).
 *
 * A sub-shell takes over the terminal input until the user exits.
 * The owning session routes keyboard events and line input to it.
 */

import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

export interface SubShellResult {
  /** Lines to display in the terminal. */
  output: string[];
  /** Whether the sub-shell has exited. */
  exit: boolean;
  /** The prompt to show for the next line of input. */
  prompt: string;
  /** Whether the terminal screen should be cleared before showing output. */
  clearScreen?: boolean;
}

export interface ISubShell {
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
   */
  processLine(line: string): SubShellResult | Promise<SubShellResult>;

  /** Clean up resources when the sub-shell exits. */
  dispose(): void;
}

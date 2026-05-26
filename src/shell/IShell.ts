/**
 * IShell — the contract every interactive shell must satisfy.
 *
 * This is the new abstraction layer that separates the *terminal*
 * (display + keyboard) from the *shell* (interactive command
 * interpreter). A Shell is reusable in any context — local terminal,
 * SSH push from a peer, nested sub-shell — because it owns ALL of its
 * own state (cwd, env, history, suStack, child shells).
 *
 * Design pattern: **Composite** — every shell can host child shells
 * (PowerShell from cmd, SqlPlus from bash). The child sits on top of
 * the parent's stack and is unwound by `exit`/`logout`/`quit`.
 *
 * Design pattern: **Strategy** — concrete shells (BashShell, CmdShell,
 * PowerShell, IOSShell, VRPShell) differ only in their command
 * dispatch + prompt + exit-words; everything else (history, special
 * keys, key handling) lives in {@link AbstractShell}.
 *
 * Design pattern: **Adapter** — the simulator's existing executors
 * (LinuxCommandExecutor, PowerShellExecutor, …) are wrapped by Shell
 * adapter classes so the new layer can be introduced without ripping
 * out the proven dispatch code.
 *
 * Lifecycle:
 *   constructor → activate() → processLine()* → (push/popChild)* →
 *   deactivate() → dispose()
 */

import type { Equipment } from '@/network';
import type { RichOutputLine } from '@/terminal/core/types';
import type { ShellContext } from './ShellContext';
import type { IShellBase, ShellConnection } from './IShellBase';

// Re-export so existing call sites keep working unchanged.
export type { ShellConnection };

/**
 * Result of processing one input line. `output` is the lines to print,
 * `childShell` (if set) is a new shell to push on top, `exit` requests
 * unwinding this shell, `clearScreen` requests the terminal to wipe.
 *
 * Shells that own their styling (ANSI colors, prompt highlight, error
 * red) should populate `styledOutput` — the terminal will render those
 * segments verbatim, bypassing any vendor-specific rendering on the host
 * session. This is what fixes the "ANSI codes raw over SSH" class of
 * bugs: the rendering is decided by the shell that produced the bytes,
 * not by the host terminal it happens to be displayed in.
 */
export interface ShellLineResult {
  readonly output: readonly string[];
  /**
   * Optional pre-styled output lines. When present, the host terminal
   * MUST render these segments and ignore `output` for visual purposes
   * (it is kept for transcript/recording).
   */
  readonly styledOutput?: readonly RichOutputLine[];
  readonly childShell?: IShell;
  readonly exit?: boolean;
  readonly clearScreen?: boolean;
  /** Suppress the next prompt (e.g. an editor takes over). */
  readonly suppressPrompt?: boolean;
}

/** Key event a shell may want to consume directly (Ctrl+C, Ctrl+L, …). */
export interface ShellKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** The handful of vendor-neutral special-key actions any shell knows. */
export type ShellSpecialAction =
  | { kind: 'cancel' }              // Ctrl+C — clear current input
  | { kind: 'clear-screen' }        // Ctrl+L — wipe display
  | { kind: 'eof' }                 // Ctrl+D — pop this shell
  | { kind: 'history-prev' }
  | { kind: 'history-next' }
  | { kind: 'none' };

export interface IShell extends IShellBase {
  // `kind` and `connection` come from IShellBase — same fields, same
  // semantics, repeated below as documentation for the IShell layer.

  /** The remote/local equipment this shell drives. */
  readonly device: Equipment;

  /** The user the shell runs as (login user, possibly su'd later). */
  readonly user: string;

  /** Execution context — cwd, env, history, suStack, parent. */
  readonly context: ShellContext;

  /** The prompt string the terminal must render for the next line. */
  getPrompt(): string;

  /** The welcome / banner lines to print when this shell is activated. */
  getActivationBanner(): readonly string[];

  /** Lines printed when this shell is deactivated (e.g. `logout`). */
  getDeactivationBanner(): readonly string[];

  /** Run one user-typed line; the result drives stack & display updates. */
  processLine(line: string): Promise<ShellLineResult> | ShellLineResult;

  /** Map a keystroke to a vendor-neutral action this shell wants to take. */
  classifyKey(e: ShellKeyEvent): ShellSpecialAction;

  /** Tab-completion candidates for the current line (full token form). */
  getCompletions(line: string): readonly string[];

  /** Lifecycle hook — called when the shell becomes the active stack frame. */
  activate(): void;

  /** Lifecycle hook — called when another shell is pushed on top of this. */
  pause(): void;

  /** Lifecycle hook — called when a child shell pops back to this one. */
  resume(): void;

  /** Lifecycle hook — called when this shell is unwound. */
  deactivate(): void;

  /** Release any held resources (file handles, sessions, …). */
  dispose(): void;
}

/**
 * QueuedTerminalIO — generic ITerminalIO whose readInput() returns a Promise
 * that the host (terminal session) resolves when the user submits a line.
 *
 * The SSH stack drives the prompt; the terminal session calls submitInput()
 * once it has collected the user's response. This decouples the SSH layer
 * from any particular UI framework.
 *
 * Reference: DESIGN-SSH-SFTP.md section 6.
 */

import type { ITerminalIO } from './TerminalSshInteractionHandler';

type LineKind = 'normal' | 'warning' | 'info' | 'prompt';

export interface QueuedTerminalIOAdapter {
  /** Render an output line on the terminal (mapped to addLine on a real session). */
  writeLine(text: string, type: LineKind): void;
  /**
   * Switch the terminal into prompt mode (password = masked input).
   * Called once just before readInput() awaits user input.
   */
  beginPrompt(prompt: string, secret: boolean): void;
  /**
   * Restore the terminal to its normal mode after a prompt resolves.
   * Called once readInput() has produced its answer.
   */
  endPrompt(): void;
}

export class QueuedTerminalIO implements ITerminalIO {
  private pendingResolve: ((value: string) => void) | null = null;

  constructor(private readonly adapter: QueuedTerminalIOAdapter) {}

  writeLine(text: string, type: LineKind = 'normal'): void {
    this.adapter.writeLine(text, type);
  }

  readInput(prompt: string, secret: boolean): Promise<string> {
    if (this.pendingResolve) {
      // A previous prompt is still awaiting input — refuse to interleave.
      return Promise.reject(
        new Error('QueuedTerminalIO: a prompt is already pending'),
      );
    }
    this.adapter.beginPrompt(prompt, secret);
    return new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  /**
   * Called by the host terminal when the user submits the input line.
   * Resolves the Promise returned by the latest readInput() call.
   * Returns true if a prompt was waiting; false otherwise (caller may then
   * deliver the input through its normal command pipeline).
   */
  submitInput(value: string): boolean {
    const resolve = this.pendingResolve;
    if (!resolve) return false;
    this.pendingResolve = null;
    this.adapter.endPrompt();
    resolve(value);
    return true;
  }

  /** Whether a prompt is currently waiting on user input. */
  get isWaitingForInput(): boolean {
    return this.pendingResolve !== null;
  }

  /**
   * Cancel a pending prompt (e.g. user pressed Ctrl-C). Resolves the Promise
   * with an empty string and lets the SSH layer treat it as an aborted entry.
   */
  cancel(): void {
    if (!this.pendingResolve) return;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.adapter.endPrompt();
    resolve('');
  }
}

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

/**
 * Thrown by readInput when the IO has been cancelled (user pressed Ctrl+C
 * during an SSH prompt). The SSH session catches it and surfaces a clean
 * "connection aborted" error instead of looping retries with empty input.
 */
export class QueuedTerminalIOCancelled extends Error {
  constructor() {
    super('SSH prompt cancelled by user');
    this.name = 'QueuedTerminalIOCancelled';
  }
}

export class QueuedTerminalIO implements ITerminalIO {
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingReject: ((reason: Error) => void) | null = null;
  private cancelled = false;

  constructor(private readonly adapter: QueuedTerminalIOAdapter) {}

  writeLine(text: string, type: LineKind = 'normal'): void {
    this.adapter.writeLine(text, type);
  }

  readInput(prompt: string, secret: boolean): Promise<string> {
    if (this.cancelled) {
      return Promise.reject(new QueuedTerminalIOCancelled());
    }
    if (this.pendingResolve) {
      return Promise.reject(
        new Error('QueuedTerminalIO: a prompt is already pending'),
      );
    }
    this.adapter.beginPrompt(prompt, secret);
    return new Promise<string>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  /**
   * Called by the host terminal when the user submits the input line.
   * Resolves the Promise returned by the latest readInput() call.
   * Returns true if a prompt was waiting; false otherwise.
   */
  submitInput(value: string): boolean {
    const resolve = this.pendingResolve;
    if (!resolve) return false;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.adapter.endPrompt();
    resolve(value);
    return true;
  }

  /** Whether a prompt is currently waiting on user input. */
  get isWaitingForInput(): boolean {
    return this.pendingResolve !== null;
  }

  /**
   * Mark the IO as cancelled. The current pending prompt (if any) is
   * rejected with QueuedTerminalIOCancelled, and every subsequent readInput
   * call will reject immediately — this propagates up through the SSH auth
   * chain and aborts the connection cleanly.
   */
  cancel(): void {
    this.cancelled = true;
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.adapter.endPrompt();
    reject?.(new QueuedTerminalIOCancelled());
  }
}

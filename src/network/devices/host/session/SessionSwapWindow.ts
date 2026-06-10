/**
 * SessionSwapWindow — the swap-and-restore protocol shared by every
 * per-terminal shell session implementation (Linux executor state,
 * Windows cwd/env, …).
 *
 * Protocol (mirrors a kernel pinning one process's state onto the CPU):
 *   1. snapshot the device-wide state,
 *   2. swap the session's state in,
 *   3. run the task,
 *   4. on success, capture mutations back into the session
 *      (unless the task is read-only),
 *   5. always restore the snapshot — even when the task throws.
 *
 * The OS-specific knowledge lives entirely in the injected protocol;
 * this class only owns the ordering and exception-safety guarantees.
 */

export interface SessionSwapProtocol<TSession, TSnapshot> {
  /** Capture the current device-wide state. */
  snapshot(): TSnapshot;
  /** Pin the session's state onto the device. */
  swapIn(session: TSession): void;
  /** Persist device-state mutations back into the session. */
  captureInto(session: TSession): void;
  /** Restore the device-wide state captured by snapshot(). */
  restore(snapshot: TSnapshot): void;
}

export interface SwapWindowOptions {
  /**
   * Capture state back into the session after a successful run.
   * Disable for read-only windows (tab completion, tail attach).
   * Default: true.
   */
  capture?: boolean;
}

export class SessionSwapWindow<TSession, TSnapshot> {
  constructor(private readonly protocol: SessionSwapProtocol<TSession, TSnapshot>) {}

  /** Run an async task inside a swap window. */
  async within<T>(
    session: TSession,
    task: () => Promise<T> | T,
    options: SwapWindowOptions = {},
  ): Promise<T> {
    const baseline = this.protocol.snapshot();
    this.protocol.swapIn(session);
    try {
      const result = await task();
      if (options.capture !== false) this.protocol.captureInto(session);
      return result;
    } finally {
      this.protocol.restore(baseline);
    }
  }

  /** Run a synchronous task inside a swap window. */
  withinSync<T>(
    session: TSession,
    task: () => T,
    options: SwapWindowOptions = {},
  ): T {
    const baseline = this.protocol.snapshot();
    this.protocol.swapIn(session);
    try {
      const result = task();
      if (options.capture !== false) this.protocol.captureInto(session);
      return result;
    } finally {
      this.protocol.restore(baseline);
    }
  }
}

/**
 * TerminalSession — Abstract base class for all terminal sessions.
 *
 * Design:
 *   - Holds ALL terminal state (lines, history, input, mode) outside React.
 *   - Uses a versioned observer pattern so React views can subscribe
 *     via useSyncExternalStore.
 *   - Subclasses override template methods for vendor-specific behaviour.
 *   - Multiple sessions can exist per device (multi-terminal support).
 *
 * Robustness:
 *   - Scrollback buffer is capped (MAX_SCROLLBACK_LINES) to prevent OOM.
 *   - Device power-off is detected before command execution.
 *   - Command execution has an optional timeout guard.
 *   - Input is sanitized against control characters.
 *   - Line ID counter uses safe modular arithmetic.
 *
 * Hierarchy:
 *   TerminalSession (base)
 *   ├── LinuxTerminalSession     — interactive prompts, ANSI, editors
 *   ├── CLITerminalSession       — boot, pager, inline help (abstract)
 *   │   ├── CiscoTerminalSession
 *   │   └── HuaweiTerminalSession
 *   └── WindowsTerminalSession   — CMD/PS dual-mode, shell nesting
 */

import { Equipment } from '@/network';

// ─── Constants ────────────────────────────────────────────────────

/** Maximum number of output lines kept in memory per session. */
const MAX_SCROLLBACK_LINES = 5000;

/** Default command execution timeout in milliseconds (30 s). */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * Safe upper bound for the line ID counter.
 * When reached, wraps back to 1.  At ~5 000 lines/session and
 * typical usage, this gives >400 000 unique IDs before wrapping.
 */
const LINE_ID_WRAP = 2_000_000_000;

// ─── Shared types ─────────────────────────────────────────────────

export interface OutputLine {
  id: number;
  text: string;
  type: string; // 'normal' | 'error' | 'warning' | 'boot' | 'more' | 'prompt' | 'ps-header'
}

/**
 * InputMode describes the current input state of the terminal.
 * The TerminalView component reads this to decide what UI to render.
 */
export type InputMode =
  | { type: 'normal' }
  | { type: 'password'; promptText: string }
  | { type: 'interactive-text'; promptText: string }
  | { type: 'pager'; indicator: string }
  | { type: 'booting' }
  | { type: 'editor'; editorType: 'nano' | 'vi' | 'vim'; filePath: string; absolutePath: string; content: string; isNewFile: boolean };

export type SessionType = 'linux' | 'cisco' | 'huawei' | 'windows';

/**
 * Pure-data theme descriptor. No React — the view maps this to styles.
 */
export interface TerminalTheme {
  sessionType: SessionType;
  backgroundColor: string;
  textColor: string;
  errorColor: string;
  promptColor: string;
  fontFamily: string;
  /** Info bar */
  infoBarBg: string;
  infoBarText: string;
  infoBarBorder: string;
  /** Optional per-type colors */
  bootColor?: string;
  pagerColor?: string;
  warningColor?: string;
}

// ─── Key event abstraction ────────────────────────────────────────

export interface KeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

// ─── Line ID generator (module-scoped, monotonic, wrap-safe) ──────

let _lineIdCounter = 0;

export function nextLineId(): number {
  _lineIdCounter = (_lineIdCounter + 1) % LINE_ID_WRAP;
  return _lineIdCounter;
}

// ─── Input sanitisation ──────────────────────────────────────────

/**
 * Strip dangerous control characters from user input.
 * Keeps printable ASCII + common whitespace + unicode text.
 * Removes: NUL, BEL, ESC sequences, DEL, and C0/C1 control chars
 * (except TAB and LF which are benign).
 */
function sanitiseInput(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// ─── Command timeout helper ──────────────────────────────────────

export class CommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms`);
    this.name = 'CommandTimeoutError';
  }
}

/**
 * Races a promise against a timeout.
 * If the promise resolves/rejects before the deadline, its result is returned.
 * Otherwise, a CommandTimeoutError is thrown.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CommandTimeoutError(timeoutMs)),
      timeoutMs,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ─── Device availability guard ───────────────────────────────────

export class DeviceOfflineError extends Error {
  constructor(deviceName: string) {
    super(`Device "${deviceName}" is powered off`);
    this.name = 'DeviceOfflineError';
  }
}

// ─── Abstract Base Class ──────────────────────────────────────────

export abstract class TerminalSession {
  readonly id: string;
  readonly device: Equipment;

  // ── Observable state ──
  lines: OutputLine[] = [];
  history: string[] = [];
  historyIndex: number = -1;
  input: string = '';
  inputMode: InputMode = { type: 'normal' };
  disposed: boolean = false;

  /** Maximum number of output lines before oldest lines are trimmed. */
  protected maxScrollback: number = MAX_SCROLLBACK_LINES;

  // ── Version-based observer (for useSyncExternalStore) ──
  private _version = 0;
  private _listeners = new Set<() => void>();

  constructor(id: string, device: Equipment) {
    this.id = id;
    this.device = device;
  }

  // ── React subscription API ──────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  getVersion = (): number => this._version;

  /** Bump version and notify all subscribers. */
  protected notify(): void {
    this._version++;
    for (const l of this._listeners) l();
  }

  // ── Public API ──────────────────────────────────────────────────

  setInput(value: string): void {
    this.input = sanitiseInput(value);
    this.notify();
  }

  addLine(text: string, type: string = 'normal'): void {
    this.lines.push({ id: nextLineId(), text, type });
    this.enforceScrollbackLimit();
    this.notify();
  }

  addLines(texts: string[], type: string = 'normal'): void {
    for (const text of texts) {
      this.lines.push({ id: nextLineId(), text, type });
    }
    this.enforceScrollbackLimit();
    this.notify();
  }

  clear(): void {
    this.lines = [];
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this._listeners.clear();
  }

  // ── Scrollback management ─────────────────────────────────────

  /**
   * Trim the oldest lines when the buffer exceeds maxScrollback.
   * Keeps the most recent lines.
   */
  private enforceScrollbackLimit(): void {
    if (this.lines.length > this.maxScrollback) {
      const excess = this.lines.length - this.maxScrollback;
      this.lines = this.lines.slice(excess);
    }
  }

  // ── Device availability ────────────────────────────────────────

  /**
   * Check whether the device is still powered on.
   * Subclasses should call this before executing commands.
   *
   * @throws DeviceOfflineError if the device is off.
   */
  protected assertDeviceOnline(): void {
    if (!this.device.getIsPoweredOn()) {
      throw new DeviceOfflineError(this.device.getName());
    }
  }

  /**
   * Convenience: check if device is online (no throw).
   */
  protected isDeviceOnline(): boolean {
    return this.device.getIsPoweredOn();
  }

  // ── Command execution helpers ─────────────────────────────────

  /**
   * Execute a command on the device with timeout and power-off guard.
   * Subclasses should prefer this over calling device.executeCommand() directly.
   *
   * @param command   The command string to execute.
   * @param timeoutMs Optional timeout override (defaults to DEFAULT_COMMAND_TIMEOUT_MS).
   * @returns The command output, or undefined/null if none.
   * @throws DeviceOfflineError if the device is powered off.
   * @throws CommandTimeoutError if execution exceeds the timeout.
   */
  protected async executeOnDevice(
    command: string,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  ): Promise<string> {
    this.assertDeviceOnline();
    return withTimeout(this.device.executeCommand(command), timeoutMs);
  }

  // ── Keyboard handling ───────────────────────────────────────────

  /**
   * Main entry point for key events.  Dispatches to mode-specific
   * handlers.  Returns true if the event was consumed.
   */
  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;

    // Delegate to mode-specific handler first
    const handled = this.handleModeKey(e);
    if (handled) return true;

    // Shared shortcuts (available in 'normal' mode across all terminals)
    if (this.inputMode.type === 'normal') {
      return this.handleNormalKey(e);
    }

    return false;
  }

  /** Override to handle keys specific to the current input mode. */
  protected abstract handleModeKey(e: KeyEvent): boolean;

  /**
   * Shared normal-mode keyboard handling.
   * Subclasses may override but should call super.handleNormalKey(e).
   */
  protected handleNormalKey(e: KeyEvent): boolean {
    // Enter → execute command
    if (e.key === 'Enter') {
      this.onEnter();
      return true;
    }

    // Ctrl+L → clear screen
    if (e.key === 'l' && e.ctrlKey) {
      this.clear();
      return true;
    }

    // Ctrl+C → abort current input
    if (e.key === 'c' && e.ctrlKey) {
      this.onCtrlC();
      return true;
    }

    // Ctrl+U → clear input line
    if (e.key === 'u' && e.ctrlKey) {
      this.setInput('');
      return true;
    }

    // Arrow Up → history previous
    if (e.key === 'ArrowUp') {
      this.historyPrev();
      return true;
    }

    // Arrow Down → history next
    if (e.key === 'ArrowDown') {
      this.historyNext();
      return true;
    }

    // Tab → completion
    if (e.key === 'Tab') {
      this.onTab();
      return true;
    }

    return false;
  }

  // ── History navigation ──────────────────────────────────────────

  protected historyPrev(): void {
    if (this.history.length === 0) return;
    const idx = this.historyIndex === -1
      ? this.history.length - 1
      : Math.max(0, this.historyIndex - 1);
    this.historyIndex = idx;
    this.input = this.history[idx] || '';
    this.notify();
  }

  protected historyNext(): void {
    if (this.historyIndex === -1) return;
    const idx = this.historyIndex + 1;
    if (idx >= this.history.length) {
      this.historyIndex = -1;
      this.input = '';
    } else {
      this.historyIndex = idx;
      this.input = this.history[idx] || '';
    }
    this.notify();
  }

  protected pushHistory(cmd: string): void {
    if (cmd) {
      this.history = [...this.history.slice(-199), cmd];
      this.historyIndex = -1;
    }
  }

  // ── Template methods (override in subclasses) ───────────────────

  /** Called on Enter in normal mode. */
  protected abstract onEnter(): void;

  /** Called on Ctrl+C in normal mode. */
  protected onCtrlC(): void {
    this.addLine(`${this.getPrompt()}${this.input}^C`);
    this.input = '';
    this.notify();
  }

  /** Called on Tab in normal mode. */
  protected abstract onTab(): void;

  /** Return the current prompt string for the input line. */
  abstract getPrompt(): string;

  /** Return the theme descriptor for rendering. */
  abstract getTheme(): TerminalTheme;

  /** Return the session type discriminator. */
  abstract getSessionType(): SessionType;

  /** Return info bar text (used by the view). */
  abstract getInfoBarContent(): { left: string; right?: string };

  /**
   * Called once after construction.  Sessions can display boot
   * sequences, banners, etc. here.  Returns a Promise so boot
   * animations can use delays.
   */
  abstract init(): Promise<void>;
}

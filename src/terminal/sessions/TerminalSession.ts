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
  | { type: 'reverse-search' }
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

  // ── Reverse search state (Ctrl+R) ─────────────────────────────
  reverseSearchQuery: string = '';
  reverseSearchMatch: string | null = null;
  private _reverseSearchIndex: number = -1;
  /** The input value saved before entering reverse-search mode. */
  private _savedInput: string = '';

  // ── Session recording ──────────────────────────────────────────
  private _recorder: SessionRecorder | null = null;

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
    // Record output events (skip prompts — those are recorded as 'input')
    if (type !== 'prompt') {
      this.recordEvent(type === 'error' ? 'error' : 'output', text);
    }
    this.notify();
  }

  addLines(texts: string[], type: string = 'normal'): void {
    for (const text of texts) {
      this.lines.push({ id: nextLineId(), text, type });
      if (type !== 'prompt') {
        this.recordEvent(type === 'error' ? 'error' : 'output', text);
      }
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

  // ── Scrollback configuration ────────────────────────────────────

  /** Get the current scrollback limit. */
  getMaxScrollback(): number {
    return this.maxScrollback;
  }

  /** Set a new scrollback limit. Immediately trims if needed. */
  setMaxScrollback(limit: number): void {
    this.maxScrollback = Math.max(100, Math.min(limit, 50_000));
    this.enforceScrollbackLimit();
    this.notify();
  }

  // ── Reverse history search (Ctrl+R) ────────────────────────────

  /**
   * Enter reverse-search mode.
   * Saves the current input and switches to the search InputMode.
   */
  enterReverseSearch(): void {
    this._savedInput = this.input;
    this.reverseSearchQuery = '';
    this.reverseSearchMatch = null;
    this._reverseSearchIndex = -1;
    this.inputMode = { type: 'reverse-search' };
    this.notify();
  }

  /**
   * Update the search query and find the most recent match.
   */
  updateReverseSearch(query: string): void {
    this.reverseSearchQuery = query;
    this._reverseSearchIndex = -1; // reset to search from end
    this.findNextReverseMatch();
  }

  /**
   * Find the next (older) match in history.
   * Called when Ctrl+R is pressed again during search.
   */
  findNextReverseMatch(): void {
    const q = this.reverseSearchQuery.toLowerCase();
    if (!q) {
      this.reverseSearchMatch = null;
      this.notify();
      return;
    }

    const startIdx = this._reverseSearchIndex === -1
      ? this.history.length - 1
      : this._reverseSearchIndex - 1;

    for (let i = startIdx; i >= 0; i--) {
      if (this.history[i].toLowerCase().includes(q)) {
        this._reverseSearchIndex = i;
        this.reverseSearchMatch = this.history[i];
        this.notify();
        return;
      }
    }

    // No match found — keep current match but don't change state
    this.notify();
  }

  /**
   * Accept the current match and exit search mode.
   */
  acceptReverseSearch(): void {
    if (this.reverseSearchMatch !== null) {
      this.input = this.reverseSearchMatch;
    } else {
      this.input = this._savedInput;
    }
    this.exitReverseSearch();
  }

  /**
   * Cancel search and restore the original input.
   */
  cancelReverseSearch(): void {
    this.input = this._savedInput;
    this.exitReverseSearch();
  }

  private exitReverseSearch(): void {
    this.reverseSearchQuery = '';
    this.reverseSearchMatch = null;
    this._reverseSearchIndex = -1;
    this._savedInput = '';
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  // ── Session recording ──────────────────────────────────────────

  /** Start recording terminal events. */
  startRecording(): void {
    this._recorder = new SessionRecorder(this.id, this.getSessionType(), this.device.getName());
    this.notify();
  }

  /** Stop recording and return the recorded data. */
  stopRecording(): SessionRecording | null {
    if (!this._recorder) return null;
    const recording = this._recorder.finalise();
    this._recorder = null;
    this.notify();
    return recording;
  }

  /** Whether the session is currently being recorded. */
  get isRecording(): boolean {
    return this._recorder !== null;
  }

  /**
   * Record an event (called internally by addLine/onEnter).
   * Protected so subclasses can record additional events.
   */
  protected recordEvent(type: RecordedEventType, data: string): void {
    this._recorder?.record(type, data);
  }

  /**
   * Replay a recording into this session (append output lines).
   * Async to allow playback at realistic speed.
   */
  async replayRecording(recording: SessionRecording, speedFactor: number = 1): Promise<void> {
    for (const event of recording.events) {
      const delay = event.delay / speedFactor;
      if (delay > 10) {
        await new Promise(r => setTimeout(r, Math.min(delay, 2000)));
      }

      if (event.type === 'input') {
        this.addLine(`${this.getPrompt()}${event.data}`, 'prompt');
      } else if (event.type === 'output') {
        this.addLine(event.data);
      } else if (event.type === 'error') {
        this.addLine(event.data, 'error');
      }
    }
  }

  // ── Keyboard handling ───────────────────────────────────────────

  /**
   * Main entry point for key events.  Dispatches to mode-specific
   * handlers.  Returns true if the event was consumed.
   */
  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;

    // Reverse search mode — intercept all keys
    if (this.inputMode.type === 'reverse-search') {
      return this.handleReverseSearchKey(e);
    }

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

    // Ctrl+R → reverse history search
    if (e.key === 'r' && e.ctrlKey) {
      this.enterReverseSearch();
      return true;
    }

    return false;
  }

  /**
   * Handle keys while in reverse-search mode.
   */
  private handleReverseSearchKey(e: KeyEvent): boolean {
    // Ctrl+R again → find next (older) match
    if (e.key === 'r' && e.ctrlKey) {
      this.findNextReverseMatch();
      return true;
    }

    // Enter → accept match and execute
    if (e.key === 'Enter') {
      this.acceptReverseSearch();
      // Execute the accepted command
      this.onEnter();
      return true;
    }

    // Escape or Ctrl+G → cancel search
    if (e.key === 'Escape' || (e.key === 'g' && e.ctrlKey)) {
      this.cancelReverseSearch();
      return true;
    }

    // Ctrl+C → cancel search
    if (e.key === 'c' && e.ctrlKey) {
      this.cancelReverseSearch();
      return true;
    }

    // Right arrow or End → accept match but stay in normal mode (don't execute)
    if (e.key === 'ArrowRight' || e.key === 'End') {
      this.acceptReverseSearch();
      return true;
    }

    // Backspace → remove last char from query
    if (e.key === 'Backspace') {
      if (this.reverseSearchQuery.length > 0) {
        this.updateReverseSearch(this.reverseSearchQuery.slice(0, -1));
      } else {
        this.cancelReverseSearch();
      }
      return true;
    }

    // Printable character → append to query
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.updateReverseSearch(this.reverseSearchQuery + e.key);
      return true;
    }

    return true; // consume all other keys while in search
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

// ─── Session Recording ───────────────────────────────────────────

export type RecordedEventType = 'input' | 'output' | 'error';

export interface RecordedEvent {
  /** Time delta since the previous event, in milliseconds. */
  delay: number;
  type: RecordedEventType;
  data: string;
}

export interface SessionRecording {
  sessionId: string;
  sessionType: SessionType;
  deviceName: string;
  startedAt: string;   // ISO 8601
  duration: number;     // total ms
  events: RecordedEvent[];
}

/**
 * Records terminal events with timing information.
 * Used internally by TerminalSession when recording is active.
 */
class SessionRecorder {
  private sessionId: string;
  private sessionType: SessionType;
  private deviceName: string;
  private events: RecordedEvent[] = [];
  private startTime: number;
  private lastEventTime: number;

  constructor(sessionId: string, sessionType: SessionType, deviceName: string) {
    this.sessionId = sessionId;
    this.sessionType = sessionType;
    this.deviceName = deviceName;
    this.startTime = Date.now();
    this.lastEventTime = this.startTime;
  }

  record(type: RecordedEventType, data: string): void {
    const now = Date.now();
    this.events.push({
      delay: now - this.lastEventTime,
      type,
      data,
    });
    this.lastEventTime = now;
  }

  finalise(): SessionRecording {
    return {
      sessionId: this.sessionId,
      sessionType: this.sessionType,
      deviceName: this.deviceName,
      startedAt: new Date(this.startTime).toISOString(),
      duration: Date.now() - this.startTime,
      events: this.events,
    };
  }
}

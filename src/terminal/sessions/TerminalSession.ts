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

import { Equipment, type HostCapableDevice } from '@/network';
import { SessionInputHost as SessionInputHostCtor } from './SessionInputHost';
import { TerminalAsyncRuntime } from '@/terminal/async';
import type { AsyncJobContext, AsyncJobHandle, AsyncJobSpec } from '@/terminal/async';
import { InteractiveFlowEngine } from '@/terminal/core/InteractiveFlow';
import { PromiseInputBroker as PromiseInputBrokerCtor, runFlowOnBroker as runFlowOnBrokerFn } from '@/shell/input';
import type { IOutputFormatter } from '@/terminal/core/OutputFormatter';
import type { FlowContext, InteractiveStep, TextSegment } from '@/terminal/core/types';

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
  /**
   * Pre-styled segments produced by the originating shell. When set, the
   * view MUST render these segments verbatim and ignore any vendor
   * heuristic on the host session (this is what fixes ANSI-over-SSH
   * displaying raw `[1;36m` in a Windows host terminal).
   */
  segments?: TextSegment[];
  /**
   * Prompt string the renderer prepends BEFORE `text` when rendering.
   * Used for command-echo lines so the prompt and the typed command are
   * stored separately. Keeps `text` clean for transcripts, search and
   * test introspection — without this separation, a typed command like
   * `ssh alice@host` would visually look like a prompt-hybrid in the
   * scrollback (the `@` would appear to belong to a foreign vendor).
   */
  promptText?: string;
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
  | { type: 'editor'; editorType: 'nano' | 'vi' | 'vim'; filePath: string; absolutePath: string; content: string; isNewFile: boolean }
  /**
   * Terminal is read-only because the underlying device is unreachable
   * (powered off, removed). Reason carries a short human label rendered by
   * the view. The session keeps its scrollback so the user can still review
   * what happened before the disconnect.
   */
  | { type: 'disconnected'; reason: string };

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
  /**
   * Active device. Mutable so an SSH session can temporarily swap the
   * remote machine in (`LinuxTerminalSession.pushRemoteDevice`) and pop
   * back to the local one when the session ends.
   */
  device: HostCapableDevice;

  // ── Observable state ──
  lines: OutputLine[] = [];
  history: string[] = [];
  historyIndex: number = -1;
  private _input: string = '';
  get input(): string { return this._children.length > 0 ? this.foreground.input : this._input; }
  set input(v: string) {
    if (this._children.length > 0) { this.foreground.input = v; return; }
    this._input = v;
  }
  inputMode: InputMode = { type: 'normal' };
  disposed: boolean = false;

  // ── Interactive input buffers (shared by Linux + CLI sessions) ──
  protected _passwordBuf: string = '';
  protected _inputBuf: string = '';

  protected readonly inputHostImpl: import('./SessionInputHost').SessionInputHost;

  protected readonly asyncRuntime: TerminalAsyncRuntime;

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

  // ── Nested-session (SSH transparent transport) ──
  private _outputHost: TerminalSession | null = null;
  private _parent: TerminalSession | null = null;
  private _children: TerminalSession[] = [];

  constructor(id: string, device: Equipment) {
    this.id = id;
    this.device = device;
    this.inputHostImpl = new SessionInputHostCtor({
      setInputMode: (kind, promptText) => {
        this.inputMode = kind === 'password'
          ? { type: 'password', promptText }
          : { type: 'interactive-text', promptText };
      },
      clearInputMode: () => { this.inputMode = { type: 'normal' }; },
      emit: (line) => this.addLine(line),
      notify: () => this.notify(),
      isDisposed: () => this.disposed,
    });
    this.asyncRuntime = new TerminalAsyncRuntime({
      addLine: (text, type) => this.addLine(text, type),
      addLines: (texts, type) => this.addLines(texts, type),
      notify: () => this.notify(),
      attachStream: (opts) => this.inputHostImpl.attachStream(opts),
    });
  }

  getInputHost(): import('@/shell/input').InputHost { return this.inputHostImpl; }

  listAttachedStreams(): readonly import('@/shell/input').StreamAttachment[] {
    if (this._children.length > 0) return this.foreground.listAttachedStreams();
    return this.inputHostImpl.listStreams();
  }

  startAsyncCommand(spec: AsyncJobSpec): AsyncJobHandle | null {
    return this.asyncRuntime.start(spec);
  }

  protected startScrollingMonitor(opts: {
    commandLine: string;
    intervalMs: number;
    frame: () => Promise<string> | string;
  }): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: opts.commandLine,
      run: async (ctx) => {
        while (!ctx.cancelled()) {
          const frame = await opts.frame();
          for (const line of frame.split('\n')) ctx.sink.line(line);
          await ctx.delay(opts.intervalMs);
        }
      },
    });
    return job !== null;
  }

  protected startFollowStream(opts: {
    commandLine: string;
    kind?: 'streaming' | 'subscription';
    prepare?: (ctx: AsyncJobContext) => boolean | string;
    subscribe: (lineSink: (line: string) => void) => () => void;
  }): boolean {
    if (this.hasForegroundAsyncJob) return false;
    let unsubscribe: (() => void) | null = null;
    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: opts.kind ?? 'streaming',
      command: opts.commandLine,
      prepare: opts.prepare,
      run: (ctx) => new Promise<void>((resolve) => {
        if (ctx.cancelled()) { resolve(); return; }
        unsubscribe = opts.subscribe((line) => ctx.sink.line(line));
        ctx.onCancel(() => { unsubscribe?.(); unsubscribe = null; resolve(); });
      }),
    });
    return job !== null;
  }

  listAsyncJobs(): AsyncJobHandle[] {
    return this.asyncRuntime.listJobs();
  }

  cancelAsyncJob(id: string): boolean {
    return this.asyncRuntime.cancel(id);
  }

  cancelAsyncJobsWhere(predicate: (handle: AsyncJobHandle) => boolean): number {
    return this.asyncRuntime.cancelWhere(predicate);
  }

  get hasForegroundAsyncJob(): boolean { return this.asyncRuntime.hasForegroundJob; }

  get hasBackgroundAsyncJobs(): boolean { return this.asyncRuntime.hasBackgroundJobs; }

  // ── React subscription API ──────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  };

  getVersion = (): number => this._version;

  /** Bump version and notify all subscribers. */
  protected notify(): void {
    if (this._outputHost) { this._outputHost.notify(); return; }
    this._version++;
    for (const l of this._listeners) l();
  }

  // ── Nested-session API (SSH = transparent transport) ─────────────

  attachAsChildOf(parent: TerminalSession): void {
    this._parent = parent;
    this._outputHost = parent._outputHost ?? parent;
    parent._children.push(this);
    this._outputHost.notify();
  }

  detachFromHost(): void {
    const parent = this._parent;
    if (!parent) return;
    const idx = parent._children.indexOf(this);
    if (idx >= 0) parent._children.splice(idx, 1);
    const root = this._outputHost;
    this._parent = null;
    this._outputHost = null;
    root?.notify();
  }

  get foreground(): TerminalSession {
    let s: TerminalSession = this;
    while (s._children.length > 0) s = s._children[s._children.length - 1];
    return s;
  }

  get hasActiveChild(): boolean { return this._children.length > 0; }

  protected get outputRoot(): TerminalSession { return this._outputHost ?? this; }

  private _remoteLabel: string | null = null;

  get isRemoteChild(): boolean { return this._parent !== null; }

  protected prepareAsRemoteUser(_user: string): void { /* vendor hook */ }

  protected applyRemoteEnv(_env: Record<string, string>): void { /* vendor hook */ }

  adoptRemoteChild(
    child: TerminalSession,
    user: string,
    hostLabel: string,
    env?: Record<string, string>,
  ): void {
    child.prepareAsRemoteUser(user);
    if (env) child.applyRemoteEnv(env);
    child._remoteLabel = hostLabel;
    child.attachAsChildOf(this);
  }

  endRemoteSession(): boolean {
    if (this._parent === null) return false;
    const label = this._remoteLabel ?? 'remote';
    this.addLine('logout');
    this.addLine(`Connection to ${label} closed.`);
    this.detachFromHost();
    this.dispose();
    return true;
  }

  // ── Public API ──────────────────────────────────────────────────

  setInput(value: string): void {
    if (this._children.length > 0) { this.foreground.setInput(value); return; }
    this.input = sanitiseInput(value);
    this.notify();
  }

  // ── Interactive input API (password prompts, GECOS, SQL*Plus, etc.) ──

  /** Current effective input mode. Override in subclasses for flow-aware modes. */
  get currentInputMode(): InputMode { return this.inputMode; }

  getPasswordBuf(): string {
    return this._children.length > 0 ? this.foreground.getPasswordBuf() : this._passwordBuf;
  }
  setPasswordBuf(value: string): void {
    if (this._children.length > 0) { this.foreground.setPasswordBuf(value); return; }
    this._passwordBuf = value;
    this.notify();
  }

  getInputBuf(): string {
    return this._children.length > 0 ? this.foreground.getInputBuf() : this._inputBuf;
  }
  setInputBuf(value: string): void {
    if (this._children.length > 0) { this.foreground.setInputBuf(value); return; }
    this._inputBuf = value;
    this.notify();
  }

  private pushLine(line: OutputLine, record: RecordedEventType | null, silent = false): void {
    const host = this._outputHost;
    if (host) {
      if (line.segments && host.getSessionType() !== this.getSessionType()) {
        line = { id: line.id, text: line.text, type: line.type, promptText: line.promptText };
      }
      host.pushLine(line, record, silent);
      return;
    }
    this.lines.push(line);
    this.enforceScrollbackLimit();
    if (record) this.recordEvent(record, line.text);
    if (!silent) this.notify();
  }

  addLine(text: string, type: string = 'normal'): void {
    this.pushLine(
      { id: nextLineId(), text, type },
      type !== 'prompt' ? (type === 'error' ? 'error' : 'output') : null,
    );
  }

  /**
   * Append a command-echo line: `promptText` is the prompt at the time
   * the user pressed Enter, `command` is what was typed. The two are
   * stored separately so the renderer can compose them visually while
   * keeping `text` clean (test / search / clipboard see the typed
   * command alone, not a prompt-hybridised string). Recorded as 'input'
   * for the transcript.
   */
  addEchoLine(promptText: string, command: string, type: string = 'prompt'): void {
    this.pushLine({ id: nextLineId(), text: command, type, promptText }, 'input');
  }

  /**
   * Append a line whose visual styling was decided by the shell that
   * produced it (typically over SSH, where the host terminal must NOT
   * apply its own vendor rendering). The plain `text` is computed from
   * the segments and is kept for transcripts / recording.
   */
  addStyledLine(segments: TextSegment[], type: string = 'normal'): void {
    const text = segments.map((s) => s.text).join('');
    this.pushLine(
      { id: nextLineId(), text, type, segments },
      type !== 'prompt' ? (type === 'error' ? 'error' : 'output') : null,
    );
  }

  addLines(texts: string[], type: string = 'normal'): void {
    const record = type !== 'prompt' ? (type === 'error' ? 'error' : 'output') : null;
    for (const text of texts) {
      this.pushLine({ id: nextLineId(), text, type }, record, true);
    }
    this.outputRoot.notify();
  }

  clear(): void {
    const root = this.outputRoot;
    root.lines = [];
    root.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.asyncRuntime.cancelAll();
    // Subclasses may register a teardown to release SSH sessions, sub-shells,
    // remote-forwarders, etc. Run them BEFORE flagging disposed so handlers
    // can still observe state if they want to.
    try {
      this.runTearDown();
    } catch {
      /* never propagate cleanup errors */
    }
    this.disposed = true;
    this._listeners.clear();
  }

  // ── Disconnection / reconnection (driven by Equipment lifecycle bus) ─

  /**
   * Mark the terminal as disconnected. The scrollback is preserved so the
   * user can re-read history, but new input is rejected. `notice` is written
   * as an error line (similar to OpenSSH "Connection to X closed").
   *
   * Idempotent — calling twice with the same reason is a no-op.
   */
  markDisconnected(reason: string, notice?: string): void {
    if (this.disposed) return;
    if (this.inputMode.type === 'disconnected' && this.inputMode.reason === reason) {
      return;
    }
    if (notice) this.addLine(notice, 'error');
    this.inputMode = { type: 'disconnected', reason };
    this.notify();
  }

  /**
   * Restore an interactive mode after the device comes back online. Idempotent.
   */
  markReconnected(notice?: string): void {
    if (this.disposed) return;
    if (this.inputMode.type !== 'disconnected') return;
    if (notice) this.addLine(notice);
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  /** True iff the session is in the read-only disconnected mode. */
  get isDisconnected(): boolean {
    return this.inputMode.type === 'disconnected';
  }

  // ── Teardown hooks (run at dispose time) ───────────────────────────

  private _tearDowns: Array<() => void> = [];

  /**
   * Register a callback fired exactly once when the session is disposed.
   * Used by SSH sessions, sub-shells, port-forwarders, agent-forwarding to
   * release their resources deterministically.
   */
  registerTearDown(cb: () => void): void {
    if (this.disposed) {
      try { cb(); } catch { /* ignore */ }
      return;
    }
    this._tearDowns.push(cb);
  }

  private runTearDown(): void {
    const cbs = this._tearDowns;
    this._tearDowns = [];
    for (const cb of cbs) {
      try { cb(); } catch { /* swallow */ }
    }
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

    // Disconnected — terminal is read-only. Only allow Ctrl+L (clear) and
    // Ctrl+Shift+C copy (handled at the view level). Everything else is
    // swallowed so the user can't desync the state by typing.
    if (this.inputMode.type === 'disconnected') {
      return true;
    }

    // Reverse search mode — intercept all keys
    if (this.inputMode.type === 'reverse-search') {
      return this.handleReverseSearchKey(e);
    }

    // Broker-driven input takes priority over the legacy mode-key handlers
    // so unified prompts (bash `read`, Read-Host, confirmations, choice
    // menus, multi-line capture) get a uniform Enter / Ctrl+C contract.
    if (this.inputHostImpl.hasPendingRequest()) {
      const brokerHandled = this.handleBrokerKey(e);
      if (brokerHandled) return true;
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

  protected handleBrokerKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const isPassword = this.inputMode.type === 'password';
      const value = isPassword ? this._passwordBuf : this._inputBuf;
      const promptText = (this.inputMode.type === 'password' || this.inputMode.type === 'interactive-text')
        ? this.inputMode.promptText : '';
      this.addEchoLine(promptText, isPassword ? '' : value);
      this._passwordBuf = '';
      this._inputBuf = '';
      this.inputHostImpl.submitPending(value);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.addLine('^C');
      this._passwordBuf = '';
      this._inputBuf = '';
      this.inputHostImpl.cancelPending();
      return true;
    }
    if (e.key === 'd' && e.ctrlKey) {
      this._passwordBuf = '';
      this._inputBuf = '';
      this.inputHostImpl.cancelPending();
      return true;
    }
    return false;
  }

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

  protected getFlowUser(): string {
    return this.device.getCurrentUser?.() ?? 'user';
  }

  // ── Interactive flow engine (shared by Linux + CLI sessions) ─────

  /**
   * Active flow engine, or null when no interactive flow is running.
   * Subclasses start flows via startFlowFromSteps().
   */
  protected flowEngine: InteractiveFlowEngine | null = null;

  /**
   * Return the output formatter for flow responses.
   * Subclasses must provide their vendor-appropriate formatter.
   * (e.g. AnsiOutputFormatter for Linux, PlainOutputFormatter for CLI)
   */
  protected abstract getFlowFormatter(): IOutputFormatter;

  /**
   * Create a FlowContext, instantiate the engine, and advance.
   * Centralises the duplicated createAndAdvanceFlow / startFlow logic.
   */
  protected startFlowFromSteps(
    steps: InteractiveStep[],
    command: string,
    extraMetadata?: Map<string, unknown>,
  ): void {
    const ctx: FlowContext = {
      values: new Map(),
      device: this.device,
      currentUser: this.getFlowUser(),
      currentUid: this.device.getCurrentUid?.() ?? 0,
      metadata: new Map<string, unknown>([
        ['original_command', command],
        ...(extraMetadata ?? []),
      ]),
      executeCommand: async (cmd: string) => this.executeOnDevice(cmd),
      onOutput: (text: string, lineType?: string) => {
        this.addLine(text, lineType || 'normal');
      },
      onClearScreen: () => this.clear(),
    };

    this._passwordBuf = '';
    this._inputBuf = '';

    if (this.inputHostImpl.capabilities().interactive) {
      this.runFlowViaBroker(steps, ctx);
      return;
    }

    this.flowEngine = new InteractiveFlowEngine(
      steps,
      ctx,
      this.getFlowFormatter(),
      this.getPrompt(),
    );
    this.advanceFlow();
  }

  protected async runFlowViaBroker(steps: InteractiveStep[], ctx: FlowContext): Promise<void> {
    const broker = new PromiseInputBrokerCtor(this.inputHostImpl);
    const result = await runFlowOnBrokerFn(steps, broker, ctx, {
      emit: (text, lineType) => this.addLine(text, lineType ?? 'normal'),
      clearScreen: () => this.clear(),
    });
    this._passwordBuf = '';
    this._inputBuf = '';
    this.inputMode = { type: 'normal' };
    if (result.status === 'ok') {
      this.onFlowComplete(result.ctx);
    }
    this.notify();
  }

  /**
   * Advance the flow engine with optional user input.
   * Maps the TerminalResponse to the session's InputMode.
   *
   * Subclasses can override onFlowComplete() to run post-flow logic
   * (e.g. sync device state, update prompt, enter sub-shells).
   */
  protected async advanceFlow(userInput?: string): Promise<void> {
    if (!this.flowEngine) return;

    const response = await this.flowEngine.advance(userInput);

    // Map response lines to addLine() calls
    for (const line of response.lines) {
      const text = line.segments.map(s => s.text).join('');
      this.addLine(text, line.lineType || 'normal');
    }

    if (this.flowEngine.isComplete) {
      const ctx = this.flowEngine.getContext();
      this.flowEngine = null;
      this._passwordBuf = '';
      this._inputBuf = '';
      this.inputMode = { type: 'normal' };
      this.onFlowComplete(ctx);
      this.notify();
    } else {
      // Map InputDirective to InputMode for the view
      const directive = response.inputDirective;
      switch (directive.type) {
        case 'password':
          this.inputMode = { type: 'password', promptText: directive.prompt };
          break;
        case 'text-prompt':
          this.inputMode = { type: 'interactive-text', promptText: directive.prompt };
          break;
        case 'confirmation':
          this.inputMode = { type: 'interactive-text', promptText: directive.prompt };
          break;
        default:
          this.inputMode = { type: 'normal' };
      }
      this.notify();
    }
  }

  /**
   * Hook called when a flow completes successfully.
   * Override in subclasses to run post-flow actions
   * (sync device state, update prompt, etc.).
   */
  protected onFlowComplete(_ctx: FlowContext): void {
    // Default: no-op. Subclasses override as needed.
  }

  /**
   * Handle keyboard input while in flow password mode.
   * Shared by Linux and CLI sessions — eliminates duplication.
   */
  protected handleFlowPasswordKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const pw = this._passwordBuf;
      this._passwordBuf = '';
      // Echo the prompt into scrollback once the user has submitted, so
      // the history shows what was asked. The password itself is masked
      // and is never logged. Avoids the duplicate-prompt UX (the input
      // row already showed the prompt while accepting input).
      if (this.inputMode.type === 'password' && this.inputMode.promptText) {
        this.addLine(this.inputMode.promptText);
      }
      this.advanceFlow(pw);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.flowEngine = null;
      this._passwordBuf = '';
      this.inputMode = { type: 'normal' };
      this.addLine('^C');
      this.notify();
      return true;
    }
    // Let the view's hidden password <input> handle the keystroke
    return false;
  }

  /**
   * Handle keyboard input while in flow interactive-text mode.
   * Shared by Linux and CLI sessions — eliminates duplication.
   */
  protected handleFlowTextKey(e: KeyEvent): boolean {
    if (e.key === 'Enter') {
      const val = this._inputBuf;
      this._inputBuf = '';
      // Echo the prompt + entered value into scrollback so the user can
      // re-read what was asked after submitting. Symmetric with
      // handleFlowPasswordKey (which echoes prompt only, password hidden).
      if (this.inputMode.type === 'interactive-text' && this.inputMode.promptText) {
        this.addLine(`${this.inputMode.promptText}${val}`);
      }
      this.advanceFlow(val);
      return true;
    }
    if (e.key === 'c' && e.ctrlKey) {
      this.flowEngine = null;
      this._inputBuf = '';
      this.inputMode = { type: 'normal' };
      this.addLine('^C');
      this.notify();
      return true;
    }
    // Let the view's interactive text <input> handle the keystroke
    return false;
  }

  /** Whether a flow is currently active. */
  get isFlowActive(): boolean {
    return this.flowEngine !== null && !this.flowEngine.isComplete;
  }

  // ── Template methods (override in subclasses) ───────────────────

  /** Called on Enter in normal mode. */
  protected abstract onEnter(): void;

  /** Called on Ctrl+C in normal mode. */
  protected onCtrlC(): void {
    if (this.asyncRuntime.interruptForeground()) return;
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

  /**
   * The shell at the top of the active stack — the shell that the user
   * is currently typing into. Default returns null; vendor sessions
   * override to surface their active IShellBase so tools, tests and the
   * UI can introspect the shell uniformly regardless of session vendor.
   *
   * This is the canonical introspection point now that every shell in
   * the project implements IShellBase: callers ask the session for its
   * active shell and read `kind`, `connection`, `getPrompt()` from it.
   */
  get activeShell(): import('@/shell/IShellBase').IShellBase | null {
    return null;
  }

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

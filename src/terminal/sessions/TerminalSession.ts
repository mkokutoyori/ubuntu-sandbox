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
import { IPAddress } from '@/network/core/types';
import { SessionInputHost as SessionInputHostCtor } from './SessionInputHost';
import { TerminalAsyncRuntime } from '@/terminal/async';
import type { AsyncJobContext, AsyncJobHandle, AsyncJobSpec } from '@/terminal/async';
import { composeSshLoginBanner } from '@/network/protocols/ssh/loginBanner';
import { QueuedTerminalIO } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import { peerLiveness } from '@/network/protocols/ssh/sessionLiveness';
import { InteractiveFlowEngine } from '@/terminal/core/InteractiveFlow';
import type { RemoteNanoController, RemoteVimController } from '@/terminal/editors/RemoteEditorController';
import { PromiseInputBroker as PromiseInputBrokerCtor, runFlowOnBroker as runFlowOnBrokerFn } from '@/shell/input';
import type { IOutputFormatter } from '@/terminal/core/OutputFormatter';
import type { FlowContext, InteractiveStep, TextSegment } from '@/terminal/core/types';
import type { EditorView } from '@/network/devices/linux/editors/EditorView';
import type { RemoteEditorTransport } from '@/terminal/editors/RemoteEditorController';
import { createRemoteEditorController } from '@/terminal/editors/RemoteEditorController';
import { parseEditorLaunch } from '@/network/devices/linux/editors/editorLaunch';

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

/**
 * Durée maximale pendant laquelle un collage garde la main avant de
 * rendre un tour au navigateur. Une trame à 60 Hz dure 16 ms : au-delà,
 * l'onglet cesse de peindre et de répondre. Découper par le TEMPS et
 * non par un nombre de lines est ce qui garde le coût nul sur un petit
 * collage tout en bornant le gel sur un gros.
 */
const PASTE_SLICE_MS = 12;

const PASTE_PROMPT_TURNS = 50;

const PASTE_SETTLE_TURNS = 2;

/**
 * Rendre la main à la boucle d'événements — vraiment. `await
 * Promise.resolve()` ne suffit pas : c'est une micro-tâche, et le
 * navigateur les épuise toutes avant de peindre quoi que ce soit.
 * Seule une macro-tâche laisse passer un rendu et les entrées.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

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
  | {
      type: 'editor';
      editorType: 'nano' | 'vi' | 'vim';
      filePath: string;
      absolutePath: string;
      content: string;
      isNewFile: boolean;
      readOnly?: boolean;
      showPosition?: boolean;
      showLineNumbers?: boolean;
      initialCursorLine?: number;
      initialCursorCol?: number;
    }
  /**
   * An editor whose buffer lives on the far side of an SSH channel: the
   * engine runs on the remote, and `controller` is the proxy the overlay
   * drives instead of a local engine
   * (docs/PRD-SSH-Unification.md §4bis B3).
   */
  | {
      type: 'remote-editor';
      editorType: 'nano' | 'vi' | 'vim';
      filePath: string;
      controller: RemoteVimController | RemoteNanoController;
    }
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
      addLine: (text, type) => {
        if (this.shouldDeferAsyncOutput()) { this.deferredAsyncLines.push({ text, type }); this.notify(); return; }
        this.addLine(text, type);
      },
      addLines: (texts, type) => {
        if (this.shouldDeferAsyncOutput()) {
          for (const text of texts) this.deferredAsyncLines.push({ text, type });
          this.notify();
          return;
        }
        this.addLines(texts, type);
      },
      notify: () => this.notify(),
      attachStream: (opts) => this.inputHostImpl.attachStream(opts),
    });
  }

  // ── Deferred async output ("logging synchronous"-style behaviour) ──
  //
  // Background/async job output (syslog monitors, debug streams, …) is
  // routed through here rather than straight into `lines` so a vendor
  // shell can defer it while the operator has an unsubmitted command in
  // progress -- reusable by any future protocol's async output, not
  // hardcoded to Cisco syslog. `shouldDeferAsyncOutput` is the opt-in
  // hook (off by default); `flushDeferredAsyncQueue` must be called by
  // the subclass at a sensible point (e.g. right before echoing a
  // newly-submitted command) or queued lines will simply build up.
  private deferredAsyncLines: Array<{ text: string; type?: string }> = [];

  protected shouldDeferAsyncOutput(): boolean { return false; }

  protected flushDeferredAsyncQueue(): void {
    if (this.deferredAsyncLines.length === 0) return;
    const pending = this.deferredAsyncLines;
    this.deferredAsyncLines = [];
    for (const { text, type } of pending) this.addLine(text, type);
  }

  // ── Idle timer (generic `exec-timeout`-style mechanism) ────────────
  //
  // Any session-affinity feature that needs to react to "no activity for
  // N ms" (Cisco/Huawei `exec-timeout`, a future Linux `TMOUT`, …) can
  // build on this instead of rolling its own setTimeout bookkeeping.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  protected armIdleTimer(ms: number, onTimeout: () => void): void {
    this.clearIdleTimer();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.idleTimer = setTimeout(() => { this.idleTimer = null; onTimeout(); }, ms);
  }

  protected clearIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /**
   * Le minuteur ABSOLU, distinct du precedent — et la distinction est
   * tout le sujet : celui-ci n'est JAMAIS reamorce par l'activite. C'est
   * ce qui separe `absolute-timeout` d'`exec-timeout`, et sans un second
   * minuteur il n'y a pas moyen de l'exprimer : reutiliser celui de
   * l'inactivite ferait repousser la limite absolue a chaque frappe,
   * c'est-a-dire ne la ferait jamais expirer pour un operateur actif —
   * exactement le cas que la commande existe pour borner.
   */
  private absoluteTimer: ReturnType<typeof setTimeout> | null = null;

  protected armAbsoluteTimer(ms: number, onTimeout: () => void): void {
    this.clearAbsoluteTimer();
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.absoluteTimer = setTimeout(() => { this.absoluteTimer = null; onTimeout(); }, ms);
  }

  protected clearAbsoluteTimer(): void {
    if (this.absoluteTimer) { clearTimeout(this.absoluteTimer); this.absoluteTimer = null; }
  }

  /** Vendor hook: called after every submitted command (activity). */
  protected onCommandActivity(): void { /* no-op by default */ }

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
    header?: () => string;
    trailer?: () => string;
    maxFrames?: number;
  }): boolean {
    if (this.hasForegroundAsyncJob) return false;
    let trailerEmitted = false;
    const emitTrailer = (ctx: AsyncJobContext) => {
      if (trailerEmitted || !opts.trailer) return;
      trailerEmitted = true;
      const t = opts.trailer();
      if (t) for (const line of t.split('\n')) ctx.sink.line(line);
    };
    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: opts.commandLine,
      run: async (ctx) => {
        if (opts.header) {
          const h = opts.header();
          if (h) for (const line of h.split('\n')) ctx.sink.line(line);
        }
        let emitted = 0;
        while (!ctx.cancelled() && (opts.maxFrames === undefined || emitted < opts.maxFrames)) {
          const frame = await opts.frame();
          for (const line of frame.split('\n')) ctx.sink.line(line);
          emitted++;
          if (opts.maxFrames !== undefined && emitted >= opts.maxFrames) break;
          await ctx.delay(opts.intervalMs);
        }
        emitTrailer(ctx);
      },
      onInterrupt: opts.trailer ? (ctx) => emitTrailer(ctx) : undefined,
    });
    return job !== null;
  }

  protected startFollowStream(opts: {
    commandLine: string;
    kind?: 'streaming' | 'subscription';
    prepare?: (ctx: AsyncJobContext) => boolean;
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

  editorSave(content: string, filePath: string): void {
    if (this._children.length > 0) { this.foreground.editorSave(content, filePath); return; }
  }

  editorExit(saved: boolean = true): void {
    if (this._children.length > 0) { this.foreground.editorExit(saved); return; }
  }

  protected get outputRoot(): TerminalSession { return this._outputHost ?? this; }

  protected firstLocalIp(): string | null {
    const ports = (this.device as unknown as { getPorts?: () => Array<{ getIPAddress: () => { toString(): string } | null; getIsUp: () => boolean }> }).getPorts?.();
    if (!ports) return null;
    for (const port of ports) {
      const ip = port.getIPAddress();
      if (ip && port.getIsUp()) return ip.toString();
    }
    return null;
  }

  private _remoteLabel: string | null = null;

  get isRemoteChild(): boolean { return this._parent !== null; }

  attachToVtyLine(): void { /* vendor hook */ }

  protected prepareAsRemoteUser(_user: string): void { /* vendor hook */ }

  protected applyRemoteEnv(_env: Record<string, string>): void { /* vendor hook */ }

  adoptRemoteChild(
    child: TerminalSession,
    user: string,
    hostLabel: string,
    env?: Record<string, string>,
    opts?: { quiet?: boolean },
  ): void {
    // The remote's own spelling of the account, so the child's prompt and
    // home match what the device actually holds — `ssh user@host` on a
    // box whose account is `User` lands in `C:\Users\User`, the same as
    // over the wire.
    const account = (child.device as unknown as {
      resolveAccountName?: (n: string) => string | undefined;
    }).resolveAccountName?.(user) ?? user;
    child.prepareAsRemoteUser(account);
    if (env) child.applyRemoteEnv(env);
    child._remoteLabel = hostLabel;
    const sourceIp = this.firstLocalIp() ?? '0.0.0.0';
    const sourceHost = this.device.getHostname?.() ?? '';
    const banner = opts?.quiet
      ? this.composeLoginBanner(child.device, account, sourceIp, sourceHost, true)
      : this.composeLoginBanner(child.device, account, sourceIp, sourceHost, false);
    child.attachAsChildOf(this);
    for (const line of banner) child.addLine(line);
  }

  /**
   * Compose the post-auth banner (issue.net + motd + "Last login: …") and
   * record the login for lastlog/auth-log purposes. `protected` so a
   * subclass can call it directly for a remote session that isn't pushed
   * as a full child (e.g. SshInteractiveSubShell — LinuxTerminalSession's
   * real-wire interactive shell), not just from `adoptRemoteChild`.
   * Delegates to the shared `composeSshLoginBanner()` (also used by
   * SshInteractiveSubShell for a *nested* ssh's own banner).
   */
  protected composeLoginBanner(
    device: unknown,
    user: string,
    sourceIp: string,
    sourceHost: string,
    quiet = false,
  ): string[] {
    return composeSshLoginBanner(device, user, sourceIp, sourceHost, quiet);
  }

  /**
   * True when the remote this session is attached to is still reachable
   * from the parent — the machine that opened the session. Read off the
   * cabled topology, never by opening a connection: a real ssh client
   * holds its channel and learns from the next write, so handshaking per
   * command would make the server log an accept/close pair for every
   * line the user types. A session that is not a remote child, or whose
   * label is not an address we can place, is always reported alive
   * (docs/PRD-Link-State.md §3.3).
   */
  protected isRemoteLinkAlive(): boolean {
    const parent = this._parent;
    const label = this._remoteLabel;
    if (parent === null || label === null) return true;
    const host = label.includes('@') ? label.slice(label.indexOf('@') + 1) : label;
    if (!IPAddress.tryParse(host)) return true;
    return peerLiveness(parent.device, host)();
  }

  /**
   * OpenSSH's reaction when the transport dies under an open session.
   * Returns true once the session has been torn down, so the caller
   * abandons the command the user just typed.
   */
  protected breakRemoteSessionIfLinkLost(): boolean {
    if (this._parent === null) return false;
    if (this.isRemoteLinkAlive()) return false;
    this.addLine('client_loop: send disconnect: Broken pipe');
    this.detachFromHost();
    this.dispose();
    return true;
  }

  /**
   * An editor typed inside a remote session opens where the file is —
   * on the remote — and only the keystrokes and the screen cross the
   * wire. Hosted here rather than in one vendor's session: which shell
   * typed `vim` says nothing about where the buffer lives
   * (docs/PRD-SSH-Unification.md §4bis B3).
   */
  protected tryOpenRemoteEditor(line: string): boolean {
    const sub = this.activeShell as unknown as {
      openRemoteEditor?: (l: string) => Promise<EditorView | null>;
      editorTransport?: () => RemoteEditorTransport;
    } | null;
    if (!sub?.openRemoteEditor || !sub.editorTransport) return false;
    if (!parseEditorLaunch(line)) return false;

    void sub.openRemoteEditor(line).then((view) => {
      if (!view) return;
      const launch = parseEditorLaunch(line)!;
      const controller = createRemoteEditorController(
        sub.editorTransport!(),
        view,
        () => this.onRemoteEditorUpdate(),
      );
      this.inputMode = {
        type: 'remote-editor',
        editorType: launch.editor,
        filePath: view.filePath,
        controller,
      };
      this.notify();
    });
    return true;
  }

  /**
   * A fresh screen arrived from the remote editor. Re-render, and hand
   * the prompt back to the SSH session once the engine has exited.
   */
  protected onRemoteEditorUpdate(): void {
    const mode = this.inputMode;
    if (mode.type !== 'remote-editor') { this.notify(); return; }
    if (mode.controller.exited) {
      this.inputMode = { type: 'normal' };
      this.addLine(this.getPrompt());
    }
    this.notify();
  }

  /**
   * Reactive SSH IO for the connection phase, shared by every vendor:
   * the SSH layer suspends on `readInput()`, the terminal resolves it
   * from the keyboard. Password and host-key dialogs therefore look the
   * same whichever shell typed `ssh` — there is one client, so there is
   * one prompt flow (docs/PRD-SSH-Unification.md §4bis).
   */
  protected pendingSshIO: QueuedTerminalIO | null = null;

  protected handleSshIOKey(e: KeyEvent): boolean {
    if (!this.pendingSshIO?.isWaitingForInput) return false;

    if (e.key === 'Enter') {
      const isPassword = this.inputMode.type === 'password';
      const val = isPassword ? this._passwordBuf : this._inputBuf;
      if (isPassword) this._passwordBuf = '';
      else this._inputBuf = '';
      // Echo the prompt (+ the non-secret answer) into scrollback so the
      // SSH host-key / password dialogs leave a trace in history once
      // submitted. Without this the prompt vanishes the moment the user
      // hits Enter, which doesn't match OpenSSH's terminal-style flow.
      // Passwords are intentionally not echoed.
      if (this.inputMode.type === 'password' || this.inputMode.type === 'interactive-text') {
        const promptText = (this.inputMode as { promptText: string }).promptText;
        if (promptText) {
          this.addLine(isPassword ? promptText : `${promptText}${val}`);
        }
      }
      // endPrompt() is called inside submitInput → resets inputMode + notify
      this.pendingSshIO.submitInput(val);
      return true;
    }

    // Suppress history navigation during SSH prompts
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return true;

    if (e.key === 'c' && e.ctrlKey) {
      this._passwordBuf = '';
      this._inputBuf = '';
      // cancel() resolves readInput with '' → SSH layer treats it as abort
      this.pendingSshIO.cancel();
      return true;
    }

    return false;
  }

  /**
   * Build a QueuedTerminalIO wired to this session's addLine / inputMode.
   * The SSH layer calls readInput() which suspends on a Promise; the terminal
   * resolves it via handleSshIOKey → submitInput().
   */
  protected createSshTerminalIO(): QueuedTerminalIO {
    const io = new QueuedTerminalIO({
      writeLine: (text, type) => this.addLine(text, type),
      beginPrompt: (prompt, secret) => {
        if (secret) {
          this._passwordBuf = '';
          this.inputMode = { type: 'password', promptText: prompt };
        } else {
          this._inputBuf = '';
          this.inputMode = { type: 'interactive-text', promptText: prompt };
        }
        this.notify();
      },
      endPrompt: () => {
        this.inputMode = { type: 'normal' };
        this.notify();
      },
    });
    this.pendingSshIO = io;
    return io;
  }

  /**
   * The single seam every Enter goes through, whatever vendor shell is
   * driving. Link loss is a property of the transport, not of the shell
   * behind it, so it is settled here once instead of in each vendor's
   * `onEnter()` — a new interpreter inherits the behaviour by existing.
   * The typed line is echoed first: the terminal is on the client side,
   * so it shows what was typed before the write fails.
   */
  private dispatchEnter(): void | Promise<void> {
    if (this._parent !== null && !this.isRemoteLinkAlive()) {
      const typed = this.input || this._inputBuf;
      this.addEchoLine(this.getPrompt(), typed);
      this.input = '';
      this._inputBuf = '';
      this.breakRemoteSessionIfLinkLost();
      return;
    }
    return this.onEnter();
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

  /**
   * Append a single line of text (newlines flattened to spaces) into
   * whichever buffer the current input mode owns. Used by paste for the
   * trailing, still-editable line and for every special-mode paste.
   */
  insertText(raw: string): void {
    const flat = raw.replace(/[\r\n]+/g, ' ');
    if (flat === '') return;
    const mode = this.currentInputMode.type;
    if (mode === 'password') {
      this.setPasswordBuf(this.getPasswordBuf() + flat);
    } else if (mode === 'interactive-text') {
      this.setInputBuf(this.getInputBuf() + flat);
    } else if (mode === 'reverse-search') {
      this.updateReverseSearch(this.reverseSearchQuery + flat);
    } else if (mode === 'normal') {
      this.setInput(this.input + flat);
    }
  }

  async pasteText(raw: string): Promise<void> {
    if (this.disposed) return;
    const normalized = raw.replace(/\r\n?/g, '\n');
    if (!normalized.includes('\n')) { this.insertText(normalized); return; }
    if (!this._multilinePasteEnabled) { this.pasteWithoutExecuting(normalized); return; }

    const lines = normalized.split('\n');
    const trailing = lines.pop() ?? '';
    this._pasteAborted = false;
    this._pasteRunning = true;
    let tranche = Date.now();
    try {
      for (let i = 0; i < lines.length; i++) {
        if (this.disposed) return;
        if (this._pasteAborted) { this.reportPasteAborted(lines.length - i); return; }
        if (!this.acceptsPastedLine()) {
          this.insertText([lines[i], ...lines.slice(i + 1), trailing].join(' '));
          return;
        }
        await this.submitPastedLine(lines[i]);
        if (Date.now() - tranche >= PASTE_SLICE_MS) {
          await yieldToEventLoop();
          tranche = Date.now();
        }
      }
      if (!this.disposed) this.insertText(trailing);
    } finally {
      this._pasteRunning = false;
    }
  }

  private acceptsPastedLine(): boolean {
    const mode = this.currentInputMode.type;
    return mode === 'normal' || mode === 'password'
      || mode === 'interactive-text' || mode === 'pager';
  }

  private async submitPastedLine(line: string): Promise<void> {
    if (this.currentInputMode.type === 'normal') {
      this.setInput(this.input + line);
      const result = this.dispatchEnter();
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        await result;
      }
      return;
    }
    const before = this.promptSignature();
    this.insertText(line);
    this.handleKey({ key: 'Enter', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });
    await this.waitForPromptToAdvance(before);
  }

  private promptSignature(): string {
    const mode = this.currentInputMode;
    const text = (mode as { promptText?: string }).promptText ?? '';
    return `${mode.type}|${text}`;
  }

  private async waitForPromptToAdvance(before: string): Promise<void> {
    for (let i = 0; i < PASTE_PROMPT_TURNS; i++) {
      await yieldToEventLoop();
      const current = this.promptSignature();
      const onCommandLine = current.startsWith('normal|');
      if (!onCommandLine && current !== before) return;
      if (onCommandLine && i >= PASTE_SETTLE_TURNS) return;
    }
  }

  private pasteWithoutExecuting(normalized: string): void {
    if (this.currentInputMode.type !== 'password') {
      this.insertText(normalized);
      return;
    }
    const [first, ...rest] = normalized.split('\n');
    this.insertText(first);
    const ignored = rest.filter((l) => l.trim() !== '').length;
    if (ignored > 0) {
      this.addLine('% Multi-line paste into a password prompt — '
        + `${ignored} further line${ignored === 1 ? '' : 's'} ignored`);
    }
  }

  private _pasteRunning = false;
  private _pasteAborted = false;

  /**
   * Un collage est-il en cours ? Lu par le Ctrl-C du terminal.
   *
   * La question porte sur la CHAÎNE entière, pas sur une session
   * précise. `pasteText` est appelé sur la session que la vue tient —
   * l'hôte — et y pose son drapeau, tandis que les premières versions
   * de ces deux accesseurs déléguaient au sous-shell le plus profond :
   * le drapeau était donc posé à un endroit et lu à un autre, et le
   * Ctrl-C d'interruption échouait en silence dès qu'un `ssh` était
   * ouvert. Chercher dans toute la chaîne rend la réponse indépendante
   * de la session sur laquelle le collage a commencé.
   */
  isPasteRunning(): boolean {
    return this.pastingSession() !== null;
  }

  /**
   * Interrompre le collage en cours. Un vrai terminal laisse toujours
   * reprendre la main sur un bloc collé par erreur ; ici la boucle ne
   * rendait jamais la main, donc la touche n'était même pas lue.
   */
  abortPaste(): boolean {
    const cible = this.pastingSession();
    if (!cible) return false;
    cible._pasteAborted = true;
    return true;
  }

  /** La session de la chaîne qui colle, la plus proche d'abord. */
  private pastingSession(): TerminalSession | null {
    let s: TerminalSession | undefined = this;
    while (s) {
      if (s._pasteRunning) return s;
      s = s._children[s._children.length - 1];
    }
    return null;
  }

  private reportPasteAborted(restantes: number): void {
    this.setInput('');
    this.addLine(`% Paste aborted — ${restantes} line${restantes === 1 ? '' : 's'} not executed`);
  }

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
    this.clearIdleTimer();
    this.clearAbsoluteTimer();
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
      this.dispatchEnter();
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
      this.onTab(e.shiftKey ?? false);
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
      this.dispatchEnter();
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
  /**
   * Le flux en cours est-il une PORTE d'authentification ?
   *
   * Ctrl+C sur un pas de flux fait `flowEngine = null` et rend la main
   * au prompt normal. Pour un flux ordinaire — un `ssh` qui demande un
   * mot de passe, une confirmation — c'est juste : on renonce et on
   * revient a son shell. Pour le flux de CONNEXION, « revenir au prompt
   * normal » EST le shell authentifie : Ctrl+C au `Username:` donnait
   * donc l'acces sans mot de passe. Un vrai IOS ne laisse pas sortir de
   * cette invite ; elle recommence.
   */
  private flowIsAuthGate = false;

  /**
   * Relance la porte d'authentification qu'on vient d'interrompre.
   * Redefinie par la session qui SAIT construire ses pas ; par defaut
   * il n'y a pas de porte, donc rien a relancer.
   */
  protected restartAuthGate(): void { /* pas de porte par defaut */ }

  protected lastFlowWasAuthGate = false;

  /** Vrai quand la session est derriere une porte d'authentification. */
  protected isAuthGateActive(): boolean {
    return this.flowIsAuthGate && this.flowEngine !== null;
  }

  /**
   * Ctrl+C pendant un flux. Rend `true` quand la touche a ete traitee.
   * Une porte d'authentification est REDEMARREE plutot qu'abandonnee.
   */
  protected cancelFlowOnCtrlC(): boolean {
    const porte = this.flowIsAuthGate;
    this.flowEngine = null;
    this.flowIsAuthGate = false;
    this._passwordBuf = '';
    this._inputBuf = '';
    this.inputMode = { type: 'normal' };
    this.addLine('^C');
    if (porte) { this.restartAuthGate(); return true; }
    this.notify();
    return true;
  }

  protected startFlowFromSteps(
    steps: InteractiveStep[],
    command: string,
    extraMetadata?: Map<string, unknown>,
    options?: { authGate?: boolean },
  ): void {
    this.flowIsAuthGate = options?.authGate === true;
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
    const porte = this.flowIsAuthGate;
    const broker = new PromiseInputBrokerCtor(this.inputHostImpl);
    const result = await runFlowOnBrokerFn(steps, broker, ctx, {
      emit: (text, lineType) => this.addLine(text, lineType ?? 'normal'),
      clearScreen: () => this.clear(),
    });
    this._passwordBuf = '';
    this._inputBuf = '';
    this.inputMode = { type: 'normal' };
    this.flowIsAuthGate = false;
    if (result.status === 'ok') {
      this.lastFlowWasAuthGate = porte;
      this.onFlowComplete(result.ctx);
      this.lastFlowWasAuthGate = false;
      this.notify();
      return;
    }
    // Le flux a ete ANNULE (Ctrl+C, Ctrl+D). Pour un flux ordinaire on
    // revient au prompt, ce qui est juste. Pour une porte
    // d'authentification, ce prompt EST le shell authentifie : on la
    // rouvre au lieu de la laisser tomber.
    if (porte) { this.restartAuthGate(); return; }
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
      const porte = this.flowIsAuthGate;
      this.flowEngine = null;
      this._passwordBuf = '';
      this._inputBuf = '';
      this.inputMode = { type: 'normal' };
      this.flowIsAuthGate = false;
      this.lastFlowWasAuthGate = porte;
      this.onFlowComplete(ctx);
      this.lastFlowWasAuthGate = false;
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
    if (e.key === 'c' && e.ctrlKey) return this.cancelFlowOnCtrlC();
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
    if (e.key === 'c' && e.ctrlKey) return this.cancelFlowOnCtrlC();
    // Let the view's interactive text <input> handle the keystroke
    return false;
  }

  /** Whether a flow is currently active. */
  get isFlowActive(): boolean {
    return this.flowEngine !== null && !this.flowEngine.isComplete;
  }

  // ── Template methods (override in subclasses) ───────────────────

  /**
   * Called on Enter in normal mode. May return a promise that resolves
   * once the command has finished executing — {@link pasteText} awaits
   * it to run pasted lines strictly one after another.
   */
  protected abstract onEnter(): void | Promise<void>;

  /** Called on Ctrl+C in normal mode. */
  protected onCtrlC(): void {
    if (this.asyncRuntime.interruptForeground()) return;
    this.addLine(`${this.getPrompt()}${this.input}^C`);
    this.input = '';
    this.notify();
  }

  /** Called on Tab in normal mode. Shift+Tab passes reverse=true. */
  protected abstract onTab(reverse?: boolean): void;

  /**
   * Ghost text opt-in. Off by default — a terminal shows the inline grey
   * completion preview only when the user explicitly enables it for that
   * session. Per-terminal, not global.
   */
  private _ghostTextEnabled = false;

  isGhostTextEnabled(): boolean {
    return this._ghostTextEnabled;
  }

  setGhostTextEnabled(enabled: boolean): void {
    if (this._ghostTextEnabled === enabled) return;
    this._ghostTextEnabled = enabled;
    this.notify();
  }

  toggleGhostText(): boolean {
    this.setGhostTextEnabled(!this._ghostTextEnabled);
    return this._ghostTextEnabled;
  }

  private _multilinePasteEnabled = true;

  isMultilinePasteEnabled(): boolean {
    return this._multilinePasteEnabled;
  }

  setMultilinePasteEnabled(enabled: boolean): void {
    if (this._multilinePasteEnabled === enabled) return;
    this._multilinePasteEnabled = enabled;
    this.notify();
  }

  toggleMultilinePaste(): boolean {
    this.setMultilinePasteEnabled(!this._multilinePasteEnabled);
    return this._multilinePasteEnabled;
  }

  /**
   * Here-document hint opt-in, same shape as ghost text: off by default,
   * per-terminal. Real bash never names the awaited delimiter — its PS2 is
   * a bare `> ` and stays that way here. This only offers a teaching aid
   * beside the prompt to whoever asks for it, and the prompt text itself
   * is never touched, so a copied transcript still reproduces.
   */
  private _heredocHintEnabled = false;

  isHeredocHintEnabled(): boolean {
    return this._heredocHintEnabled;
  }

  setHeredocHintEnabled(enabled: boolean): void {
    if (this._heredocHintEnabled === enabled) return;
    this._heredocHintEnabled = enabled;
    this.notify();
  }

  toggleHeredocHint(): boolean {
    this.setHeredocHintEnabled(!this._heredocHintEnabled);
    return this._heredocHintEnabled;
  }

  /**
   * The status-line hint when one applies — null everywhere but a session
   * that is actually collecting a here-document body with the opt-in on.
   */
  getHeredocHint(): string | null {
    if (!this._heredocHintEnabled) return null;
    const delimiter = this.pendingHeredocDelimiter();
    return delimiter === null ? null : `waiting for: ${delimiter}`;
  }

  /** Overridden by sessions that model here-document accumulation. */
  protected pendingHeredocDelimiter(): string | null { return null; }

  /**
   * Ghost text: the inline grey continuation shown after the caret when
   * exactly one completion exists for the current input. Gated by the
   * per-session opt-in; sessions with a completion source override
   * `computeGhostSuggestion()`, never this.
   */
  getGhostSuggestion(): string | null {
    if (!this._ghostTextEnabled) return null;
    return this.computeGhostSuggestion();
  }

  /**
   * Compute the ghost remainder for the current input, ignoring the
   * enabled flag (the caller gates). Base has no completion source.
   */
  protected computeGhostSuggestion(): string | null {
    return null;
  }

  /** Accept the current ghost suggestion into the input buffer. */
  acceptGhost(): boolean {
    const ghost = this.getGhostSuggestion();
    if (ghost === null || ghost.length === 0) return false;
    this.input += ghost;
    this.notify();
    return true;
  }

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

  /**
   * Le terminal a-t-il ete pousse dans une machine distante par `ssh` ?
   *
   * La banniere qui rend cette information etait appelee sous un cast
   * `session as LinuxTerminalSession`, sur le seul critere
   * `getSessionType() === 'linux'`. Le cast etait un MENSONGE des qu'une
   * session non-Linux declarait ce type pour son rendu — un FortiGate le
   * fait — et la consequence n'etait pas cosmetique : l'appel levait, la
   * banniere n'a pas de garde-fou d'erreur, et l'arbre React s'effondrait,
   * donc le terminal ne s'ouvrait pas du tout. La question appartient a la
   * session ; la reponse par defaut est « non ».
   */
  getSshContextInfo(): {
    active: boolean;
    chain: readonly { host: string; user: string }[];
    current: string | null;
  } {
    return { active: false, chain: [], current: null };
  }

  /**
   * La decomposition `user@hote:chemin$` de l'invite, quand elle a un
   * sens.
   *
   * `foreign: true` est la reponse « mon invite n'a pas cette forme,
   * rends `getPrompt()` tel quel » — et c'est la reponse JUSTE pour tout
   * ce qui n'est pas un interprete bash : un FortiGate ecrit
   * `FGT1 (policy) # `, un ASA `ciscoasa(config)# `. Le rendu appelait
   * cette methode sous le meme cast que la banniere SSH, avec la meme
   * consequence : l'appel levait et le terminal ne s'ouvrait pas.
   */
  getPromptParts(): {
    user: string; hostname: string; path: string; promptChar: string;
    foreign?: boolean;
  } {
    return { user: '', hostname: '', path: '', promptChar: '', foreign: true };
  }

  /**
   * Le nom de la plateforme, tel que la barre de titre le montre.
   *
   * Il etait DEDUIT de `SessionType`, une enumeration a quatre valeurs :
   * un ASA et un routeur IOS partagent `'cisco'`, donc la fenetre d'un
   * pare-feu s'intitulait « Cisco IOS » pendant que sa propre barre
   * d'information disait « Cisco ASA 5506-X ». Deux vues du meme fait,
   * dont une devinait. La session sait ce qu'elle est ; elle le dit.
   */
  platformLabel(): string | null { return null; }

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

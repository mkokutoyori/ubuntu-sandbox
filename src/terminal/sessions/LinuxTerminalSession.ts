/**
 * LinuxTerminalSession — Ubuntu terminal emulation model.
 *
 * Features ported from the original Terminal.tsx:
 *   - Interactive multi-step prompts (sudo, su, passwd, adduser)
 *   - ANSI color support (handled in the view via AnsiRenderer)
 *   - Text editors (nano, vi, vim) via EditorOverlay
 *   - Colored prompt (user@host:path$)
 *   - Tab completion
 */

import { Equipment } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType,
  KeyEvent, InputMode, withTimeout, DeviceOfflineError,
} from './TerminalSession';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { AnsiOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { completeInput } from '@/terminal/core/TabCompletionHelper';
import { LinuxFlowBuilder } from '@/terminal/flows/LinuxFlowBuilder';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman/ReactiveRmanSubShell';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import { RemoteShellSubShell } from '@/terminal/subshells/RemoteShellSubShell';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { TerminalSshInteractionHandler } from '@/network/protocols/ssh/session/TerminalSshInteractionHandler';
import { QueuedTerminalIO, QueuedTerminalIOCancelled } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import { isOk } from '@/network/protocols/ssh/Result';
import {
  parseSshKeygenArgs,
  generateAndWriteKeyPair,
} from '@/network/protocols/ssh/SshKeygen';
import { sshCopyId } from '@/network/protocols/ssh/SshCopyId';
import { parseScpArgs } from '@/network/protocols/ssh/Scp';
import { SshConfig } from '@/network/protocols/ssh/SshConfig';
import { SshLocalForwarder } from '@/network/protocols/ssh/SshLocalForwarder';
import { SshRemoteForwarder } from '@/network/protocols/ssh/SshRemoteForwarder';
import { SshDynamicForwarder } from '@/network/protocols/ssh/SshDynamicForwarder';
import { SshAgentForwarding } from '@/network/protocols/ssh/SshAgentForwarding';
import {
  parseSshArgs,
  parseProxyJumpSpec,
  type DynamicForward,
  type LocalForward,
  type ParsedSshArgs,
  type ProxyHop,
  type RemoteForward,
} from './sshArgs';
import type { TcpConnector } from '@/network/core/TcpConnection';
import type { ISubShell } from '@/terminal/subshells/ISubShell';
import { handleLsnrctl, handleTnsping, handleDbca, handleOrapwd, handleAdrci, handleExpdp, handleImpdp } from '@/terminal/commands/OracleCommands';
import type { FlowContext, InteractiveStep } from '@/terminal/core/types';

// ─── Theme ────────────────────────────────────────────────────────

const LINUX_THEME: TerminalTheme = {
  sessionType: 'linux',
  backgroundColor: '#300a24',
  textColor: '#ffffff',
  errorColor: '#ef2929',
  promptColor: '#8ae234',
  fontFamily: "'Ubuntu Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'Monaco', monospace",
  infoBarBg: '#2c0a1f',
  infoBarText: '#c0a0b0',
  infoBarBorder: '#5c3d50',
};

// ─── Session ──────────────────────────────────────────────────────

export class LinuxTerminalSession extends TerminalSession {
  currentPath: string;
  currentUser: string;
  private readonly _flowFormatter = new AnsiOutputFormatter();
  /** Tab suggestions currently shown (null = hidden) */
  tabSuggestions: string[] | null = null;
  /** Active sub-shell (SQL*Plus, or any future REPL). Null when in normal bash mode. */
  private activeSubShell: ISubShell | null = null;
  /** Command history for the active sub-shell. */
  private subShellHistory: string[] = [];
  /** History navigation index for the active sub-shell (-1 = not navigating). */
  private subShellHistoryIndex: number = -1;
  /** Saved input before history navigation started. */
  private subShellSavedInput: string = '';

  /**
   * Stack of SSH "frames" — each entry remembers the local device and
   * the saved cwd/user pair that were active before connecting to a
   * remote machine. The terminal becomes the remote machine's terminal
   * (BRD SSH-04: every command runs on the remote, editors open on the
   * remote, tab completion uses the remote VFS) until the user types
   * `exit` / `logout` or presses Ctrl+D.
   */
  private sshStack: Array<{
    device: Equipment;
    user: string;
    path: string;
    /** Local shell session paused while this remote frame is active. */
    pausedShell: LinuxShellSession | null;
    /** Closing callback (e.g. ssh session disconnect). */
    onPop: () => void;
    /** Display string used in "Connection to <X> closed." line. */
    label: string;
  }> = [];

  /**
   * Reactive SSH IO: holds the QueuedTerminalIO that bridges the async SSH
   * connection layer (host-key prompts, password prompts) to the terminal's
   * key-handling pipeline. Non-null only while an SSH connection is in progress.
   */
  private pendingSshIO: QueuedTerminalIO | null = null;

  /**
   * Per-terminal shell session (allocated on Linux machines). Holds the
   * cwd/env/su-stack/job-table/history that belong to *this* terminal
   * exclusively. Null when running on a non-Linux device (e.g. a future
   * embedded board falling back to the legacy shared executor).
   *
   * See terminal_gap.md §2.
   */
  shell: LinuxShellSession | null = null;

  /**
   * Pending tail of a compound command (`mkdir foo && nano foo/x &&
   * cat foo/x`) whose middle segment was an editor invocation. The
   * editor overlay takes over the UI; once it exits, we resume the
   * chain. Null while no editor is suspended.
   *
   * Each element is a [connector, command] pair: connector is the
   * operator that ties the segment to the editor's exit code
   * ('&&' = only-on-success, '||' = only-on-failure, ';' = always).
   */
  private _pendingChainAfterEditor: Array<{ connector: ';' | '&&' | '||'; cmd: string }> | null = null;

  constructor(id: string, device: Equipment) {
    super(id, device);
    // Allocate a dedicated -bash on the device when possible so multiple
    // terminals on the same machine have isolated cwd / env / su stack.
    if (device instanceof LinuxMachine) {
      this.shell = device.openShellSession();
      this.currentPath = this.shell.cwd;
      this.currentUser = this.shell.user;
      // Make sure the terminal tears down its session when the manager
      // disposes it (closing tty, killing -bash, releasing pts slot).
      this.registerTearDown(() => {
        const s = this.shell;
        if (s && device instanceof LinuxMachine) {
          device.closeShellSession(s);
        }
        this.shell = null;
      });
    } else {
      this.currentPath = device.getCwd() || '/home/user';
      this.currentUser = device.getCurrentUser() || 'user';
    }
  }

  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

  /**
   * Route every command through the per-terminal shell session so that
   * cwd / env / su stack mutations stay local to this terminal. Falls back
   * to the shared executor only when no session has been allocated (e.g.
   * the device is not a LinuxMachine).
   */
  protected override async executeOnDevice(
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    const dev = this.device;
    if (!dev.getIsPoweredOn()) throw new DeviceOfflineError(dev.getName());
    if (this.shell && dev instanceof LinuxMachine) {
      const promise = dev.executeCommandInSession(command, this.shell);
      return timeoutMs != null ? withTimeout(promise, timeoutMs) : promise;
    }
    return super.executeOnDevice(command, timeoutMs);
  }

  // ── Template implementations ────────────────────────────────────

  getSessionType(): SessionType { return 'linux'; }
  getTheme(): TerminalTheme { return LINUX_THEME; }

  getPrompt(): string {
    const hostname = this.device.getHostname() || 'localhost';
    const user = this.currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = this.currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return `${user}@${hostname}:${path}${promptChar} `;
  }

  /** Structured prompt parts for the colored prompt renderer. */
  getPromptParts() {
    const hostname = this.device.getHostname() || 'localhost';
    const user = this.currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = this.currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return { user, hostname, path, promptChar };
  }

  getInfoBarContent() {
    // The InfoBar identifies the local terminal modal — it must NOT change
    // when the user `ssh`-pushes onto a remote. The colored bash prompt
    // rendered for every command line still shows the remote host (see
    // `getPromptParts`), which is the right place to surface that.
    const local = this.getLocalDevice();
    const hostname = local.getHostname() || 'localhost';
    const homeDir =
      this.localUser === 'root' ? '/root' : `/home/${this.localUser}`;
    let path = this.localPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) {
      path = '~' + path.slice(homeDir.length);
    }
    return { left: `${this.localUser}@${hostname}: ${path}` };
  }

  /**
   * Device the terminal modal is rooted on, i.e. the local host the user
   * opened the terminal from. Distinct from `this.device`, which points
   * at the *currently active* device — that may be a remote when SSH
   * frames are pushed on the stack.
   */
  getLocalDevice(): Equipment {
    return this.sshStack.length === 0
      ? this.device
      : this.sshStack[0].device;
  }

  /** User on the local device (bottom of the SSH stack). */
  private get localUser(): string {
    return this.sshStack.length === 0
      ? this.currentUser
      : this.sshStack[0].user;
  }

  /** Path on the local device (bottom of the SSH stack). */
  private get localPath(): string {
    return this.sshStack.length === 0
      ? this.currentPath
      : this.sshStack[0].path;
  }

  async init(): Promise<void> {
    // Linux terminal has no boot sequence — ready immediately
  }

  // ── Input mode ──────────────────────────────────────────────────

  override get currentInputMode(): InputMode {
    // Reactive SSH IO takes priority: the SSH layer is waiting for user input
    // (password or host-key confirmation). inputMode is set by the IO adapter's
    // beginPrompt(), so just returning it is enough — but we gate here first so
    // handleKey() can route to handleSshIOKey() before any flow/sub-shell check.
    if (this.pendingSshIO?.isWaitingForInput) {
      return this.inputMode;
    }
    if (this.activeSubShell) {
      return { type: 'interactive-text', promptText: this.activeSubShell.getPrompt() };
    }
    if (this.isFlowActive) {
      return this.inputMode; // already set by advanceFlow()
    }
    return this.inputMode;
  }

  // ── Key handling ────────────────────────────────────────────────

  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;

    // Reactive SSH IO: the SSH layer is awaiting user input (password or
    // host-key confirmation). Handle Enter/Ctrl+C here; everything else
    // falls through to the view's input element (character typing).
    if (this.pendingSshIO?.isWaitingForInput) {
      return this.handleSshIOKey(e);
    }

    // Sub-shell active (SQL*Plus, etc.) — route input there
    if (this.activeSubShell) {
      return this.handleSubShellKey(e);
    }

    // Flow engine active — delegate to base class handlers
    if (this.isFlowActive) {
      if (this.inputMode.type === 'password') return this.handleFlowPasswordKey(e);
      if (this.inputMode.type === 'interactive-text') return this.handleFlowTextKey(e);
    }

    // Editor mode is handled by the view component (NanoEditor / VimEditor)
    if (this.inputMode.type === 'editor') return false;

    return super.handleKey(e);
  }

  /**
   * Key handler used while a reactive SSH IO prompt is active.
   * Submits input on Enter, cancels on Ctrl+C, suppresses history navigation.
   */
  private handleSshIOKey(e: KeyEvent): boolean {
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
  private createSshTerminalIO(): QueuedTerminalIO {
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

  protected handleModeKey(_e: KeyEvent): boolean {
    // All mode handling is done in the overridden handleKey above
    return false;
  }

  protected handleNormalKey(e: KeyEvent): boolean {
    // Ctrl+A → beginning of line (handled by view's input element, but consume)
    if (e.key === 'a' && e.ctrlKey) return true;
    // Ctrl+E → end of line
    if (e.key === 'e' && e.ctrlKey) return true;

    // Tab
    if (e.key === 'Tab') {
      this.onTab();
      return true;
    }

    // Clear tab suggestions on any non-Tab key
    if (this.tabSuggestions && e.key !== 'Tab') {
      this.tabSuggestions = null;
      this.notify();
    }

    return super.handleNormalKey(e);
  }

  // ── Command execution ───────────────────────────────────────────

  protected onEnter(): void {
    const cmd = this.input;
    this.input = '';
    this.tabSuggestions = null;
    this.recordEvent('input', cmd);
    this.executeCommand(cmd);
    this.notify();
  }

  private async executeCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();

    // Echo command with prompt
    this.addLine(`${this.getPrompt()}${cmd}`);

    // Handle exit/logout
    if (trimmed === 'exit' || trimmed === 'logout') {
      // BRD SSH-04-R4/R5: when nested in an SSH session, exit/logout
      // unwinds in this order:
      //   1. The active device's su stack (if any) — `exit` from
      //      `root@remote` returns to `user@remote`, NOT to the local
      //      terminal.
      //   2. Once the device is at its root su level, the SSH stack
      //      frame is popped, returning to the previous device.
      //   3. If neither is active, the terminal closes.
      //
      // The su stack lives on the per-terminal LinuxShellSession (since
      // §2). Calling the legacy device.handleExit() would consult the
      // device-wide shared executor stack — which is always empty — and
      // close the terminal prematurely. Route through the session-aware
      // method when a shell session is allocated (terminal_gap.md §10.1).
      const dev = this.device;
      const exitResult = (this.shell && dev instanceof LinuxMachine)
        ? dev.handleExitInSession(this.shell)
        : dev.handleExit();
      if (exitResult.inSu) {
        if (exitResult.output) this.addLine(exitResult.output);
        this.syncDeviceState();
        return;
      }
      if (this.sshStack.length > 0) {
        this.popRemoteDevice();
        return;
      }
      // Signal close — the view/manager will handle it
      this._onRequestClose?.();
      return;
    }

    // Add to history
    this.pushHistory(trimmed);

    // Intercept editor commands — at top level OR embedded in a chain
    // (`mkdir foo && nano foo/x`). The chain is parsed up to the first
    // editor invocation: the prefix runs through the device, then the
    // editor opens with its tail stashed in _pendingChainAfterEditor.
    // On editor exit we resume the tail using the exit code semantics
    // (`&&` only on success, `||` only on failure, `;` always).
    const chain = parseShellChain(trimmed);
    const editorIdx = chain.findIndex((seg) => isEditorSegment(seg.cmd));
    if (editorIdx >= 0) {
      const prefix = chain.slice(0, editorIdx);
      const editorSeg = chain[editorIdx];
      const tail = chain.slice(editorIdx + 1);
      // Run prefix; only open editor if connector semantics permit.
      // For top-level (no prefix) editor invocation we open straight away.
      if (prefix.length === 0) {
        this.openEditorFromCmd(editorSeg.cmd);
        if (tail.length > 0) this._pendingChainAfterEditor = tail;
        return;
      }
      // Run the prefix as a regular compound command, then evaluate
      // the editor segment's connector against the resulting exit code.
      const prefixCmd = prefix.map((s, i) => i === 0 ? s.cmd : `${s.connector} ${s.cmd}`).join(' ');
      this.runPrefixThenEditor(prefixCmd, editorSeg, tail);
      return;
    }

    // Intercept Oracle CLI tools (only if no sudo prefix)
    if (!trimmed.startsWith('sudo ')) {
      const noSudo = trimmed;
      const parts = noSudo.split(/\s+/);
      if (parts[0] === 'sqlplus') {
        this.enterSqlPlus(parts.slice(1));
        return;
      }
      if (parts[0] === 'rman') {
        this.enterRman(parts.slice(1));
        return;
      }
      if (parts[0] === 'sftp') {
        this.enterSftp(parts.slice(1));
        return;
      }
      if (parts[0] === 'ssh') {
        await this.enterSsh(parts.slice(1));
        return;
      }
      if (parts[0] === 'ssh-keygen') {
        await this.enterSshKeygen(parts.slice(1));
        return;
      }
      if (parts[0] === 'ssh-copy-id') {
        this.enterSshCopyId(parts.slice(1));
        return;
      }
      if (parts[0] === 'scp') {
        this.enterScp(parts.slice(1));
        return;
      }
      if (parts[0] === 'lsnrctl') {
        handleLsnrctl(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
      if (parts[0] === 'tnsping') {
        handleTnsping(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
      if (parts[0] === 'dbca') {
        handleDbca(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
      if (parts[0] === 'orapwd') {
        handleOrapwd(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
      if (parts[0] === 'adrci') {
        handleAdrci(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
      if (parts[0] === 'expdp') {
        handleExpdp(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
      if (parts[0] === 'impdp') {
        handleImpdp(this.device, parts.slice(1), (text, type) => this.addLine(text, type));
        this.notify();
        return;
      }
    }

    // Check if this command needs interactive prompts
    // (handles sudo password for `sudo sqlplus`, sudo passwd, su, etc.)
    if (this.startInteractiveFlow(trimmed)) {
      return;
    }

    // Execute directly (with timeout + device-online guard)
    try {
      const result = await this.executeOnDevice(trimmed);
      if (result) {
        if (result.includes('\x1b[2J') || result.includes('\x1b[H')) {
          this.clear();
        } else {
          this.addLine(result);
        }
      }
      this.syncDeviceState();
    } catch (err) {
      if (err instanceof Error && err.name === 'DeviceOfflineError') {
        // The bus-driven path (TerminalManager.onDevicePoweredOff) already
        // writes a "Connection to <host> lost: device powered off." notice
        // and flips the session to `disconnected` mode. Only emit the
        // ad-hoc "Connection lost" line when the session is NOT yet in
        // that state — otherwise the two notices stack on top of each
        // other (terminal_gap.md §9.4).
        if (!this.isDisconnected) {
          this.addLine(`\x1b[31mConnection lost: device is powered off\x1b[0m`, 'error');
          this.inputMode = { type: 'normal' };
        }
      } else if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine(`\x1b[31mCommand timed out\x1b[0m`, 'error');
      } else {
        this.addLine(`Error: ${err}`, 'error');
      }
    }
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(): void {
    // Tab completion must run in *this* terminal's session context so that
    // path completion sees the per-session cwd, not the device-wide shared one.
    const dev = this.device;
    const completions = (this.shell && dev instanceof LinuxMachine)
      ? dev.getCompletionsForSession(this.input, this.shell)
      : this.device.getCompletions(this.input);
    if (completions.length === 0) return;

    const result = completeInput(this.input, completions);
    this.input = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }

  // ── Editor integration ──────────────────────────────────────────

  /**
   * Parse a single editor segment (e.g. "nano /tmp/x" or "sudo vim foo")
   * and open the editor with its args. Returns false when the segment
   * is not actually an editor invocation (defensive — caller already
   * checked).
   */
  private openEditorFromCmd(cmd: string): boolean {
    const noSudo = cmd.startsWith('sudo ') ? cmd.slice(5).trim() : cmd;
    const parts = noSudo.split(/\s+/);
    const head = parts[0];
    if (head !== 'nano' && head !== 'vi' && head !== 'vim') return false;
    this.openEditor(head, parts.slice(1));
    return true;
  }

  /**
   * Run the chain segments leading up to an editor, then open the editor
   * (respecting the segment's connector). Implemented separately so the
   * `mkdir foo && nano foo/x` UX matches a real shell: the prefix's
   * stdout/stderr is rendered before the editor takes over.
   */
  private async runPrefixThenEditor(
    prefixCmd: string,
    editorSeg: { connector: ';' | '&&' | '||'; cmd: string },
    tail: Array<{ connector: ';' | '&&' | '||'; cmd: string }>,
  ): Promise<void> {
    let prefixExitCode = 0;
    try {
      const result = await this.executeOnDevice(prefixCmd);
      if (result) this.addLine(result);
      // The executor's lastExitCode is captured back into the session
      // by executeCommandInSession's captureStateInto.
      prefixExitCode = this.shell?.lastExitCode ?? 0;
    } catch (err) {
      if (err instanceof Error && err.name !== 'DeviceOfflineError') {
        this.addLine(`Error: ${err}`, 'error');
      }
      prefixExitCode = 1;
    }
    // Connector semantics — does the editor segment run?
    const shouldRun = shouldExecuteSegment(editorSeg.connector, prefixExitCode);
    if (!shouldRun) {
      // Editor is skipped — fall through to the tail with the prefix's exit.
      if (tail.length > 0) {
        void this.executeChain(tail, prefixExitCode);
      }
      return;
    }
    if (this.openEditorFromCmd(editorSeg.cmd)) {
      if (tail.length > 0) this._pendingChainAfterEditor = tail;
    }
  }

  /**
   * Resume an interrupted chain after the editor exits. Each remaining
   * segment is gated by its connector against the running exit code.
   */
  private async executeChain(
    chain: Array<{ connector: ';' | '&&' | '||'; cmd: string }>,
    initialExitCode: number,
  ): Promise<void> {
    let exitCode = initialExitCode;
    let i = 0;
    while (i < chain.length) {
      const seg = chain[i];
      if (!shouldExecuteSegment(seg.connector, exitCode)) {
        i++;
        continue;
      }
      // Editor in the resumed tail? Stop here, open it, stash the rest.
      if (isEditorSegment(seg.cmd)) {
        if (this.openEditorFromCmd(seg.cmd)) {
          const remainder = chain.slice(i + 1);
          if (remainder.length > 0) this._pendingChainAfterEditor = remainder;
          return;
        }
      }
      // Otherwise run it like a normal command via executeOnDevice.
      try {
        const r = await this.executeOnDevice(seg.cmd);
        if (r) this.addLine(r);
        exitCode = this.shell?.lastExitCode ?? 0;
      } catch (err) {
        if (err instanceof Error && err.name !== 'DeviceOfflineError') {
          this.addLine(`Error: ${err}`, 'error');
        }
        exitCode = 1;
      }
      i++;
    }
    this.syncDeviceState();
  }

  private openEditor(editorCmd: 'nano' | 'vi' | 'vim', args: string[]): void {
    let filePath = '';
    for (const arg of args) {
      if (!arg.startsWith('-') && !arg.startsWith('+')) { filePath = arg; break; }
    }
    if (!filePath) filePath = editorCmd === 'nano' ? 'New Buffer' : '';

    // Resolve against the per-terminal cwd when a shell session is owned
    // (terminal_gap.md §10.1) — falls back to the device's shared cwd for
    // non-Linux devices.
    const dev = this.device;
    const absolutePath = (this.shell && dev instanceof LinuxMachine)
      ? dev.resolveAbsolutePathInSession(filePath, this.shell)
      : this.device.resolveAbsolutePath(filePath);
    const existingContent = (this.shell && dev instanceof LinuxMachine)
      ? dev.readFileForEditorInSession(absolutePath, this.shell)
      : this.device.readFileForEditor(absolutePath);
    const isNewFile = existingContent === null;

    this.inputMode = {
      type: 'editor',
      editorType: editorCmd,
      filePath: absolutePath,
      absolutePath,
      content: existingContent ?? '',
      isNewFile,
    };
    this.notify();
  }

  /** Called by the view when editor saves a file. */
  editorSave(content: string, filePath: string): void {
    const dev = this.device;
    if (this.shell && dev instanceof LinuxMachine) {
      dev.writeFileFromEditorInSession(filePath, content, this.shell);
    } else {
      this.device.writeFileFromEditor(filePath, content);
    }
  }

  /**
   * Called by the view when an editor exits. If the editor was opened
   * as part of a compound command (`mkdir foo && nano foo/x`), run the
   * tail of the chain — see openEditor / executeChain (§10.3).
   * `saved=true` corresponds to exit-with-save (e.g. nano ^X→Y, vim :wq),
   * making the editor "succeed" for chain semantics; `saved=false`
   * corresponds to an abort (nano ^X→N, vim :q!), exit code 1.
   */
  editorExit(saved: boolean = true): void {
    this.inputMode = { type: 'normal' };
    const tail = this._pendingChainAfterEditor;
    this._pendingChainAfterEditor = null;
    this.notify();
    if (tail && tail.length > 0) {
      // Drive the rest of the chain asynchronously so the React tree
      // can settle out of the editor overlay first.
      void this.executeChain(tail, saved ? 0 : 1);
    }
  }

  // ── Device state sync ───────────────────────────────────────────

  private syncDeviceState(): void {
    // When the terminal owns a shell session, the per-session state is
    // authoritative — reading device.getCwd() would leak the shared default
    // and cause cross-terminal cwd bleed-through (cf. terminal_gap.md §2).
    if (this.shell) {
      this.currentPath = this.shell.cwd;
      this.currentUser = this.shell.user;
    } else {
      const cwd = this.device.getCwd();
      if (cwd) this.currentPath = cwd;
      this.currentUser = this.device.getCurrentUser();
    }
    this.notify();
  }

  // ── Close callback ─────────────────────────────────────────────

  private _onRequestClose?: () => void;
  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }

  // ── Interactive flow ────────────────────────────────────────────

  /**
   * Check if a command needs interactive prompts and start the flow if so.
   * Returns true if a flow was started, false otherwise.
   */
  private startInteractiveFlow(command: string): boolean {
    const currentUser = this.device.getCurrentUser();
    const currentUid = this.device.getCurrentUid();

    // Check for sudo sqlplus / sudo rman — special case: enter sub-shell after sudo auth
    const noSudo = command.startsWith('sudo ') ? command.slice(5).trim() : command;
    const cmdParts = noSudo.split(/\s+/);
    if (cmdParts[0] === 'rman' && command.startsWith('sudo ')) {
      const steps = LinuxFlowBuilder.build(command, currentUser, currentUid, this.device);
      if (steps) {
        const rmanArgs = cmdParts.slice(1);
        const patchedSteps: InteractiveStep[] = steps.map(step => {
          if (step.type === 'execute' && step.action) {
            return {
              ...step,
              action: async (ctx: FlowContext) => {
                ctx.metadata.set('enter_rman', JSON.stringify(rmanArgs));
              },
            };
          }
          return step;
        });
        this.startFlowFromSteps(patchedSteps, command);
        return true;
      }
    }
    if (cmdParts[0] === 'sqlplus' && command.startsWith('sudo ')) {
      const steps = LinuxFlowBuilder.build(command, currentUser, currentUid, this.device);
      if (steps) {
        // Replace the generic execute step with sqlplus entry
        const sqlplusArgs = cmdParts.slice(1);
        const patchedSteps: InteractiveStep[] = steps.map(step => {
          if (step.type === 'execute' && step.action) {
            return {
              ...step,
              action: async (ctx: FlowContext) => {
                ctx.metadata.set('enter_sqlplus', JSON.stringify(sqlplusArgs));
              },
            };
          }
          return step;
        });
        this.startFlowFromSteps(patchedSteps, command);
        return true;
      }
    }

    const steps = LinuxFlowBuilder.build(command, currentUser, currentUid, this.device);
    if (!steps) return false;

    this.startFlowFromSteps(steps, command);
    return true;
  }

  /** Post-flow hook: sync device state and handle special actions (e.g. enter sqlplus). */
  protected override onFlowComplete(ctx: FlowContext): void {
    // Check for special post-flow actions
    const rmanArgs = ctx.metadata.get('enter_rman') as string | undefined;
    if (rmanArgs) {
      this.enterRman(JSON.parse(rmanArgs));
      return;
    }
    const sqlplusArgs = ctx.metadata.get('enter_sqlplus') as string | undefined;
    if (sqlplusArgs) {
      this.enterSqlPlus(JSON.parse(sqlplusArgs));
      return;
    }
    const sftpMeta = ctx.metadata.get('enter_sftp') as string | undefined;
    if (sftpMeta) {
      const { userAtHost, batchFile } = JSON.parse(sftpMeta) as {
        userAtHost: string;
        batchFile?: string | null;
      };
      const password = ctx.values.get('sftp_password') ?? '';
      this.connectAndEnterSftp(userAtHost, password, batchFile ?? null);
      return;
    }
    // enter_ssh is no longer set — enterSsh() now calls connectAndEnterSsh()
    // directly using the reactive QueuedTerminalIO approach.
    const sshKeygenMeta = ctx.metadata.get('enter_ssh_keygen') as string | undefined;
    if (sshKeygenMeta) {
      const meta = JSON.parse(sshKeygenMeta) as { args: string[]; defaultFile: string };
      const filePath = (ctx.values.get('keygen_file') ?? '').trim() || meta.defaultFile;
      const passphrase = ctx.values.get('keygen_passphrase') ?? '';
      const confirm = ctx.values.get('keygen_passphrase_confirm') ?? '';
      if (passphrase !== confirm) {
        this.addLine('Passphrases do not match.  Try again.', 'error');
        this.notify();
        return;
      }
      const expandedArgs = [...meta.args];
      if (!expandedArgs.includes('-f')) expandedArgs.push('-f', filePath);
      if (!expandedArgs.includes('-N')) expandedArgs.push('-N', passphrase);
      this.runSshKeygen(expandedArgs);
      return;
    }
    const sshCopyMeta = ctx.metadata.get('enter_ssh_copy_id') as string | undefined;
    if (sshCopyMeta) {
      const meta = JSON.parse(sshCopyMeta) as {
        userAtHost: string;
        identityFile: string;
      };
      const password = ctx.values.get('ssh_copy_id_password') ?? '';
      this.runSshCopyId(meta, password);
      return;
    }
    const scpMeta = ctx.metadata.get('enter_scp') as string | undefined;
    if (scpMeta) {
      const meta = JSON.parse(scpMeta) as {
        userAtHost: string;
        port: number;
        identityFiles: string[];
        local: { path: string };
        remote: { path: string };
        direction: 'upload' | 'download';
        recursive: boolean;
      };
      const password = ctx.values.get('scp_password') ?? '';
      this.runScp(meta, password);
      return;
    }
    this.syncDeviceState();
  }

  // ── Sub-shell management ───────────────────────────────────────

  private enterSqlPlus(args: string[]): void {
    try {
      const { subShell, banner, loginOutput } = SqlPlusSubShell.create(this.device, args);
      this.activeSubShell = subShell;

      for (const line of banner) this.addLine(line);
      for (const line of loginOutput) this.addLine(line);
      this.addLine('');

      this._inputBuf = '';
      this.notify();
    } catch (err) {
      this.addLine(`bash: sqlplus: ${err instanceof Error ? err.message : String(err)}`, 'error');
      this.notify();
    }
  }

  private enterRman(args: string[]): void {
    try {
      const { subShell, banner } = ReactiveRmanSubShell.create(this.device, args);
      this.activeSubShell = subShell;

      for (const line of banner) this.addLine(line);

      this._inputBuf = '';
      this.notify();
    } catch (err) {
      this.addLine(`bash: rman: ${err instanceof Error ? err.message : String(err)}`, 'error');
      this.notify();
    }
  }

  /**
   * Start an interactive sftp session.
   * Parses args for `[user@]host`, prompts for a password, then connects.
   * Non-interactive batch-mode transfers (sftp user@host:/path /local) are
   * handled by the LinuxCommandExecutor fallback (returns a canned error for now).
   */
  private enterSftp(args: string[]): void {
    // Strip flags we care about and find the host argument.
    let batchFile: string | null = null;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-b' && i + 1 < args.length) {
        batchFile = args[++i];
      } else if (!a.startsWith('-')) {
        positional.push(a);
      }
    }
    const userAtHost = positional[0] ?? '';
    if (!userAtHost) {
      this.addLine('usage: sftp [options] [user@]host[:path]', 'error');
      this.notify();
      return;
    }

    // Derive display name for the password prompt ("user@host's password:")
    const user = userAtHost.includes('@')
      ? userAtHost.split('@')[0]
      : this.currentUser;
    const host = userAtHost.includes('@')
      ? userAtHost.split('@')[1]
      : userAtHost;
    const displayTarget = `${user}@${host}`;

    const steps: InteractiveStep[] = [
      {
        type: 'password',
        prompt: `${displayTarget}'s password: `,
        mask: 'hidden',
        storeAs: 'sftp_password',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          ctx.metadata.set(
            'enter_sftp',
            JSON.stringify({ userAtHost: displayTarget, batchFile }),
          );
        },
      },
    ];
    this.startFlowFromSteps(steps, `sftp ${userAtHost}`);
  }

  private async connectAndEnterSftp(
    userAtHost: string,
    password: string,
    batchFile: string | null = null,
  ): Promise<void> {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined };
      };
      tcpConnect?: (host: string, port: number) => Promise<unknown>;
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) {
      this.addLine('sftp: this device does not support SFTP', 'error');
      this.notify();
      return;
    }

    const tcpConnector: TcpConnector = (host, port) =>
      (dev.tcpConnect?.(host, port) ?? Promise.resolve(null)) as ReturnType<TcpConnector>;

    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const session = new SftpSession({
      tcpConnector,
      localVfs: localVfs as never,
      localUser: this.currentUser,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      localCwd: this.currentPath,
      knownHostsPath: `${homeDir}/.ssh/known_hosts`,
      interactionHandler: new SilentSshInteractionHandler(password),
      homeDirectory: homeDir,
    });

    const banner = await session.connect(userAtHost, { password });
    if (!session.isConnected()) {
      this.addLine(banner, 'error');
      this.notify();
      return;
    }
    this.addLine(banner);

    // BRD SFTP-13 / analysis doc P5: `sftp -b <file>` runs the batch then
    // exits without installing the interactive sub-shell. Each line of the
    // batch is echoed with the prompt (mirroring OpenSSH), output captured,
    // and the session is disconnected at EOF. A leading `-` on a command
    // suppresses failure (parity with OpenSSH).
    if (batchFile) {
      await this.runSftpBatch(session, localVfs, batchFile);
      this._inputBuf = '';
      this.notify();
      return;
    }

    this.activeSubShell = new SftpSubShell(session);
    this._inputBuf = '';
    this.notify();
  }

  private async runSftpBatch(
    session: SftpSession,
    vfs: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem,
    batchPath: string,
  ): Promise<void> {
    const raw = vfs.readFile(batchPath);
    if (raw === null) {
      this.addLine(`Couldn't open batch file ${batchPath}`, 'error');
      session.disconnect();
      return;
    }
    const shell = new SftpSubShell(session);
    const lines = raw.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const ignoreErrors = line.startsWith('-');
      const cmd = ignoreErrors ? line.slice(1).trim() : line;
      this.addLine(`${shell.getPrompt()}${cmd}`);
      const result = shell.processLine(cmd);
      for (const out of result.output) {
        if (out) this.addLine(out);
      }
      if (result.exit) break;
      if (!ignoreErrors && hasSftpError(result.output)) break;
    }
    session.disconnect();
  }

  // ── ssh entry point ─────────────────────────────────────────────

  /**
   * Parse `ssh [options] [user@]host [command...]` and start either an
   * interactive sub-shell (BRD SSH-04) or a one-shot exec (BRD SSH-05).
   *
   * Supported flags: -p <port>, -i <keyfile>, -o StrictHostKeyChecking=value.
   */
  private async enterSsh(args: string[]): Promise<void> {
    const parsed = parseSshArgs(args);
    if (!parsed) {
      this.addLine(
        'usage: ssh [-p port] [-i identity_file] [-o option=value] [user@]host [command...]',
        'error',
      );
      this.notify();
      return;
    }
    // BRD SSH-06: merge ~/.ssh/config defaults under CLI overrides.
    const merged = this.mergeWithSshConfig(parsed);
    // OpenSSH `-J host1[,host2,...]` (ProxyJump): walk each hop before
    // opening the final connection. Each hop is pushed onto the SSH
    // stack so `exit` unwinds one hop at a time, matching real ssh -J.
    if (merged.jumpHosts && merged.jumpHosts.length > 0) {
      const hops = merged.jumpHosts.flatMap((h) => [
        ...parseProxyJumpSpec(h),
      ]);
      if (!this.pushSshChain(hops)) {
        this.addLine(
          `ssh: could not resolve one or more jump hosts: ${merged.jumpHosts.join(', ')}`,
          'error',
        );
        this.notify();
        return;
      }
    }
    // Reactive approach: connect directly — password (and host-key confirmation)
    // are prompted lazily by TerminalSshInteractionHandler via QueuedTerminalIO,
    // only when the SSH layer actually needs them (e.g. public-key auth succeeds
    // silently without ever asking for a password). `merged` carries
    // `hashKnownHosts` from CLI `-o` / ~/.ssh/config (analysis doc §1.6).
    await this.connectAndEnterSsh(merged);
  }

  private async connectAndEnterSsh(
    meta: {
      userAtHost: string;
      port: number;
      identityFiles: readonly string[];
      strict: 'yes' | 'no' | 'accept-new';
      command: string | null;
      hashKnownHosts?: boolean;
      localForwards?: readonly LocalForward[];
      remoteForwards?: readonly RemoteForward[];
      dynamicForwards?: readonly DynamicForward[];
      forwardAgent?: boolean;
      requestTty?: 'yes' | 'no' | 'force';
    },
  ): Promise<void> {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: unknown;
        userMgr?: {
          getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined;
        };
      };
      tcpConnect?: (host: string, port: number) => Promise<unknown>;
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) {
      this.addLine('ssh: this device does not support SSH', 'error');
      this.notify();
      return;
    }
    const tcpConnector: TcpConnector = (host, port) =>
      (dev.tcpConnect?.(host, port) ?? Promise.resolve(null)) as ReturnType<TcpConnector>;
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const user = meta.userAtHost.includes('@')
      ? meta.userAtHost.split('@')[0]
      : this.currentUser;
    const host = meta.userAtHost.includes('@')
      ? meta.userAtHost.split('@')[1]
      : meta.userAtHost;

    // Reactive IO: password and host-key prompts are shown on demand by
    // TerminalSshInteractionHandler → QueuedTerminalIO → handleSshIOKey().
    // Public-key auth that succeeds silently will never trigger a password prompt.
    const io = this.createSshTerminalIO();
    const session = new SshSession({
      tcpConnector,
      vfs: localVfs as never,
      localUser: this.currentUser,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      knownHostsPath: `${homeDir}/.ssh/known_hosts`,
      interactionHandler: new TerminalSshInteractionHandler(io),
    });

    const builder = SshConnectOptionsBuilder.create()
      .host(host)
      .user(user)
      .port(meta.port)
      .strictHostKeyChecking(meta.strict);
    // Analysis doc §1.6: forward HashKnownHosts (CLI -o or ~/.ssh/config).
    if (meta.hashKnownHosts) builder.hashKnownHosts(true);
    for (const id of this.autoDiscoverIdentityFiles(meta.identityFiles)) {
      builder.addIdentityFile(id);
    }

    let result: Awaited<ReturnType<typeof session.connect>> | null = null;
    let cancelled = false;
    try {
      result = await session.connect(builder.build());
    } catch (err) {
      if (err instanceof QueuedTerminalIOCancelled) {
        cancelled = true;
      } else {
        throw err;
      }
    } finally {
      // Always release the reactive IO once the connection phase is over,
      // regardless of success or failure.
      this.pendingSshIO = null;
      if (this.inputMode.type === 'password' || this.inputMode.type === 'interactive-text') {
        this.inputMode = { type: 'normal' };
      }
      this.notify();
    }

    if (cancelled) {
      this.addLine('^C', 'normal');
      session.disconnect();
      this.notify();
      return;
    }

    if (!result || !isOk(result)) {
      const errKind = result
        ? (result as { error: { kind: string } }).error.kind
        : 'UNKNOWN';
      // AUTH_FAILED is already surfaced via showWarning() inside doAuthenticate();
      // do not duplicate it. Other errors have no prior warning, so display them here.
      if (errKind !== 'AUTH_FAILED') {
        const msg =
          errKind === 'CONNECTION_REFUSED'
            ? `ssh: connect to host ${host} port ${meta.port}: No route to host`
            : errKind === 'HOST_KEY_REJECTED' || errKind === 'HOST_KEY_CHANGED'
            ? 'Host key verification failed.'
            : `${user}@${host}: Permission denied (publickey,password).`;
        this.addLine(msg, 'error');
      }
      this.notify();
      return;
    }

    if (meta.command) {
      // OpenSSH parity: announce PTY allocation BEFORE running the command
      // when the user explicitly asked for one (`-t` / `-tt`).
      if (meta.requestTty === 'yes' || meta.requestTty === 'force') {
        this.addLine(
          'Pseudo-terminal will be allocated because a request was made.',
        );
      }
      // BRD SSH-05: non-interactive — run the command, print output, close.
      const channelResult = session.openExecChannel(meta.command);
      if (!isOk(channelResult)) {
        this.addLine('ssh: failed to open exec channel', 'error');
        session.disconnect();
        this.notify();
        return;
      }
      const exec = await channelResult.value.execute();
      if (exec.stdout) {
        for (const line of exec.stdout.replace(/\n$/, '').split('\n')) {
          this.addLine(line);
        }
      }
      if (exec.stderr) {
        for (const line of exec.stderr.replace(/\n$/, '').split('\n')) {
          this.addLine(line, 'error');
        }
      }
      channelResult.value.close();
      session.disconnect();
      this.notify();
      return;
    }

    // BRD SSH-04: interactive — try to push the remote device onto the
    // terminal stack so the user gets a true remote shell (editors,
    // tab-completion, history). If the remote machine cannot be
    // resolved (e.g. tests using a synthetic SshServerHandler), fall
    // back to RemoteShellSubShell which forwards each line as an exec.
    //
    // Banner composition: prefer the in-process LinuxMachine path because
    // it gives us the canonical OpenSSH ordering (Welcome → motd → blank
    // → Last login). Falls back to the exec-channel reads when the remote
    // is a synthetic handler that doesn't materialise a LinuxMachine.
    const remoteForBanner = findLinuxMachineByIp(host);
    const bannerLines = remoteForBanner
      ? composeLoginBanner(remoteForBanner, user)
      : await this.composeLoginBannerViaExec(session, user);
    for (const line of bannerLines) this.addLine(line);

    // OpenSSH `-L`: register local-port forwarders on the local device,
    // each tunnelling new connections through this SSH session.
    const forwarders = this.installLocalForwards(session, host, meta);
    // OpenSSH `-D`: SOCKS proxy on a local port — symmetric placement to
    // `-L` (always on the local device).
    const dynamicForwarders = this.installDynamicForwards(session, host, meta);
    // OpenSSH `-R`: needs the remote device — registered only when the
    // SSH peer resolves to a local Equipment instance (the common case
    // for the tutorial LAN).
    const remoteDevice = findLinuxMachineByIp(host);
    const remoteForwarders = remoteDevice
      ? this.installRemoteForwards(session, host, remoteDevice, meta)
      : [];
    // OpenSSH `-A`: shadow-copy the local SshAgent into the remote one,
    // so `ssh-add -l` on the remote (and any further `ssh` from there)
    // sees the client's keys for the duration of the session.
    const agentForwarding = remoteDevice
      ? this.installAgentForwarding(remoteDevice, meta)
      : null;
    const onSessionEnd = () => {
      for (const f of forwarders) f.dispose();
      for (const f of dynamicForwarders) f.dispose();
      for (const f of remoteForwarders) f.dispose();
      agentForwarding?.detach();
      session.disconnect();
    };

    if (remoteDevice) {
      this.pushRemoteDevice(remoteDevice, user, host, onSessionEnd);
      return;
    }
    this.activeSubShell = new RemoteShellSubShell(session, user, host, `/home/${user}`);
    this._inputBuf = '';
    this.notify();
  }

  /** Best-effort `lastlog`-style line via a one-shot remote exec. */
  private async tryReadLastLogin(session: SshSession, user: string): Promise<string | null> {
    const channelResult = session.openExecChannel(
      `last -i ${user} 2>/dev/null | head -n 1`,
    );
    if (!isOk(channelResult)) return null;
    const channel = channelResult.value;
    const result = await channel.execute();
    channel.close();
    const out = result.stdout.replace(/\n$/, '');
    return out || null;
  }

  /**
   * SSH-03-R9: when the user did not pass -i, auto-discover the standard
   * identity files in ~/.ssh/. Returns the original list when at least one
   * `-i` was supplied (CLI explicit choice wins).
   */
  private autoDiscoverIdentityFiles(
    explicit: readonly string[],
  ): string[] {
    if (explicit.length > 0) return [...explicit];
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { home?: string } | undefined };
      };
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) return [];
    const home =
      dev.executor?.userMgr?.getUser(this.currentUser)?.home ??
      `/home/${this.currentUser}`;
    const candidates = [
      `${home}/.ssh/id_ed25519`,
      `${home}/.ssh/id_rsa`,
      `${home}/.ssh/id_ecdsa`,
    ];
    return candidates.filter((p) => localVfs.exists(p));
  }

  /**
   * Resolve ~/.ssh/config for the host the user typed, merge CLI overrides
   * on top, and rewrite the final userAtHost when the config maps an alias
   * to a different HostName / User. CLI flags win over the file.
   */
  private mergeWithSshConfig(parsed: ParsedSshArgs): ParsedSshArgs {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { home?: string } | undefined };
      };
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) return parsed;
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const configContent = localVfs.readFile(`${homeDir}/.ssh/config`);
    if (!configContent) return parsed;
    const cliUser = parsed.userAtHost.includes('@')
      ? parsed.userAtHost.split('@')[0]
      : null;
    const targetHost = parsed.userAtHost.includes('@')
      ? parsed.userAtHost.split('@')[1]
      : parsed.userAtHost;
    const entry = SshConfig.parse(configContent).resolve(targetHost);

    const finalHost = entry.hostName ?? targetHost;
    const finalUser = cliUser ?? entry.user ?? this.currentUser;
    const finalPort =
      // CLI wins when explicitly set (parser default = 22 means "unset").
      parsed.port !== 22 ? parsed.port : entry.port ?? parsed.port;
    const finalIdentityFiles =
      parsed.identityFiles.length > 0
        ? parsed.identityFiles
        : entry.identityFile
        ? [entry.identityFile]
        : parsed.identityFiles;
    const finalStrict =
      // accept-new is the parser default ; treat it as "unset" too.
      parsed.strict !== 'accept-new'
        ? parsed.strict
        : entry.strictHostKeyChecking ?? parsed.strict;
    return {
      userAtHost: `${finalUser}@${finalHost}`,
      port: finalPort,
      identityFiles: finalIdentityFiles,
      strict: finalStrict,
      command: parsed.command,
      hashKnownHosts: parsed.hashKnownHosts ?? entry.hashKnownHosts,
      jumpHosts: parsed.jumpHosts,
      localForwards: parsed.localForwards,
      remoteForwards: parsed.remoteForwards,
      dynamicForwards: parsed.dynamicForwards,
      forwardAgent: parsed.forwardAgent,
      requestTty: parsed.requestTty,
    };
  }

  // ── ssh-keygen ──────────────────────────────────────────────────

  /**
   * `ssh-keygen` entry point. When invoked with `-f` and `-N` flags it
   * runs non-interactively. Otherwise OpenSSH prompts the user for a
   * destination file and a passphrase (BRD SSH-03-R1..R4, R10).
   */
  private async enterSshKeygen(args: string[]): Promise<void> {
    const dev = this.device as unknown as {
      executor?: {
        userMgr?: { getUser(name: string): { home?: string } | undefined };
      };
    };
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const opts = parseSshKeygenArgs(args, homeDir);
    const hasFlagF = args.includes('-f');
    const hasFlagN = args.includes('-N');

    // Both -f and -N supplied → non-interactive.
    if (hasFlagF && hasFlagN) {
      this.runSshKeygen(args);
      return;
    }

    // Build an interactive flow: file path → passphrase → confirm passphrase.
    const steps: InteractiveStep[] = [];
    if (!hasFlagF) {
      steps.push({
        type: 'text',
        prompt: `Enter file in which to save the key (${opts.file}): `,
        storeAs: 'keygen_file',
      });
    }
    if (!hasFlagN) {
      steps.push({
        type: 'password',
        prompt: `Enter passphrase (empty for no passphrase): `,
        mask: 'hidden',
        storeAs: 'keygen_passphrase',
      });
      steps.push({
        type: 'password',
        prompt: `Enter same passphrase again: `,
        mask: 'hidden',
        storeAs: 'keygen_passphrase_confirm',
      });
    }
    steps.push({
      type: 'execute',
      action: async (ctx: FlowContext) => {
        ctx.metadata.set(
          'enter_ssh_keygen',
          JSON.stringify({ args, defaultFile: opts.file }),
        );
      },
    });
    this.startFlowFromSteps(steps, `ssh-keygen ${args.join(' ')}`);
  }

  /**
   * Non-interactive `ssh-keygen` (BRD SSH-03-R1..R3, R10).
   * Writes the key pair under ~/.ssh/ on the local VFS.
   */
  private runSshKeygen(args: string[]): void {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined };
      };
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) {
      this.addLine('ssh-keygen: this device has no filesystem', 'error');
      this.notify();
      return;
    }
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const opts = parseSshKeygenArgs(args, homeDir);
    const result = generateAndWriteKeyPair(
      localVfs,
      userEntry?.uid ?? 1000,
      userEntry?.gid ?? 1000,
      opts,
    );
    if ('error' in result) {
      this.addLine(`ssh-keygen: ${result.error}`, 'error');
      this.notify();
      return;
    }
    for (const line of result.output) this.addLine(line);
    this.notify();
  }

  // ── ssh-copy-id ─────────────────────────────────────────────────

  /**
   * Parse `ssh-copy-id [-i identity] [user@]host` then collect the password.
   * BRD SSH-03-R5.
   */
  private enterSshCopyId(args: string[]): void {
    let identityFile = '';
    let userAtHost = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-i' && i + 1 < args.length) identityFile = args[++i];
      else if (!args[i].startsWith('-')) userAtHost = args[i];
    }
    if (!userAtHost) {
      this.addLine('usage: ssh-copy-id [-i identity_file] [user@]host', 'error');
      this.notify();
      return;
    }
    const dev = this.device as unknown as {
      executor?: {
        userMgr?: { getUser(name: string): { home?: string } | undefined };
      };
    };
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const resolvedIdentity = identityFile || `${homeDir}/.ssh/id_ed25519`;
    const displayTarget = userAtHost.includes('@')
      ? userAtHost
      : `${this.currentUser}@${userAtHost}`;

    const steps: InteractiveStep[] = [
      {
        type: 'password',
        prompt: `${displayTarget}'s password: `,
        mask: 'hidden',
        storeAs: 'ssh_copy_id_password',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          ctx.metadata.set(
            'enter_ssh_copy_id',
            JSON.stringify({
              userAtHost: displayTarget,
              identityFile: resolvedIdentity,
            }),
          );
        },
      },
    ];
    this.startFlowFromSteps(steps, `ssh-copy-id ${userAtHost}`);
  }

  private async runSshCopyId(
    meta: { userAtHost: string; identityFile: string },
    password: string,
  ): Promise<void> {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
      };
      tcpConnect?: (host: string, port: number) => Promise<unknown>;
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) {
      this.addLine('ssh-copy-id: no local filesystem', 'error');
      this.notify();
      return;
    }
    const pubPath = `${meta.identityFile}.pub`;
    const publicKeyLine = localVfs.readFile(pubPath);
    if (!publicKeyLine) {
      this.addLine(
        `/usr/bin/ssh-copy-id: ERROR: failed to open ID file '${pubPath}': No such file or directory`,
        'error',
      );
      this.notify();
      return;
    }
    const session = await this.connectSshForBatch(meta.userAtHost, password);
    if (!session) return;
    const user = meta.userAtHost.split('@')[0];
    const remoteHome = `/home/${user}`;
    const result = await sshCopyId(session, publicKeyLine.trim(), remoteHome);
    session.disconnect();
    if ('error' in result) {
      this.addLine(`ssh-copy-id: ${result.error}`, 'error');
    } else {
      for (const line of result.output) {
        this.addLine(
          line.replace('<user>', user).replace('<host>', meta.userAtHost.split('@')[1] ?? ''),
        );
      }
    }
    this.notify();
  }

  // ── scp ─────────────────────────────────────────────────────────

  /** BRD SSH-08: parse scp args, collect password, defer transfer. */
  private enterScp(args: string[]): void {
    const parsed = parseScpArgs(args);
    if (!parsed) {
      this.addLine('usage: scp [-r] [-P port] [-i identity_file] src dst', 'error');
      this.notify();
      return;
    }
    const remoteEndpoint = parsed.source.remote ? parsed.source : parsed.destination;
    const localEndpoint = parsed.source.remote ? parsed.destination : parsed.source;
    if (parsed.source.remote === parsed.destination.remote) {
      this.addLine(
        'scp: exactly one of source/destination must be remote',
        'error',
      );
      this.notify();
      return;
    }
    const direction: 'upload' | 'download' = parsed.source.remote
      ? 'download'
      : 'upload';
    const user = remoteEndpoint.user ?? this.currentUser;
    const host = remoteEndpoint.host ?? '';
    const displayTarget = `${user}@${host}`;

    const steps: InteractiveStep[] = [
      {
        type: 'password',
        prompt: `${displayTarget}'s password: `,
        mask: 'hidden',
        storeAs: 'scp_password',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          ctx.metadata.set(
            'enter_scp',
            JSON.stringify({
              userAtHost: displayTarget,
              port: parsed.port,
              identityFiles: parsed.identityFiles,
              local: { path: localEndpoint.path },
              remote: { path: remoteEndpoint.path },
              direction,
              recursive: parsed.recursive,
            }),
          );
        },
      },
    ];
    this.startFlowFromSteps(steps, `scp ${args.join(' ')}`);
  }

  private async runScp(
    meta: {
      userAtHost: string;
      port: number;
      identityFiles: string[];
      local: { path: string };
      remote: { path: string };
      direction: 'upload' | 'download';
      recursive: boolean;
    },
    password: string,
  ): Promise<void> {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined };
      };
      tcpConnect?: (host: string, port: number) => Promise<unknown>;
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) {
      this.addLine('scp: no local filesystem', 'error');
      this.notify();
      return;
    }
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const tcpConnector: TcpConnector = (host, port) =>
      (dev.tcpConnect?.(host, port) ?? Promise.resolve(null)) as ReturnType<TcpConnector>;

    const sftp = new SftpSession({
      tcpConnector,
      localVfs,
      localUser: this.currentUser,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      localCwd: this.currentPath,
      knownHostsPath: `${homeDir}/.ssh/known_hosts`,
      interactionHandler: new SilentSshInteractionHandler(password),
      homeDirectory: homeDir,
    });
    const banner = await sftp.connect(meta.userAtHost, {
      port: meta.port,
      identityFiles: this.autoDiscoverIdentityFiles(meta.identityFiles),
      password,
    });
    if (!sftp.isConnected()) {
      this.addLine(banner, 'error');
      this.notify();
      return;
    }

    const transferOutput =
      meta.direction === 'upload'
        ? meta.recursive
          ? sftp.putRecursive(meta.local.path, meta.remote.path)
          : sftp.put(meta.local.path, meta.remote.path)
        : meta.recursive
        ? sftp.getRecursive(meta.remote.path, meta.local.path)
        : sftp.get(meta.remote.path, meta.local.path);
    for (const line of transferOutput.split('\n')) {
      if (line) this.addLine(line);
    }
    sftp.disconnect();
    this.notify();
  }

  /** Common helper: auth-only SshSession used by ssh-copy-id. */
  private async connectSshForBatch(
    userAtHost: string,
    password: string,
  ): Promise<SshSession | null> {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined };
      };
      tcpConnect?: (host: string, port: number) => Promise<unknown>;
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs) return null;
    const tcpConnector: TcpConnector = (host, port) =>
      (dev.tcpConnect?.(host, port) ?? Promise.resolve(null)) as ReturnType<TcpConnector>;
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const user = userAtHost.split('@')[0];
    const host = userAtHost.split('@')[1] ?? userAtHost;
    const session = new SshSession({
      tcpConnector,
      vfs: localVfs,
      localUser: this.currentUser,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      knownHostsPath: `${homeDir}/.ssh/known_hosts`,
      interactionHandler: new SilentSshInteractionHandler(password),
    });
    const builder = SshConnectOptionsBuilder.create()
      .host(host)
      .user(user)
      .port(22)
      .strictHostKeyChecking('accept-new')
      .password(password);
    for (const id of this.autoDiscoverIdentityFiles([])) {
      builder.addIdentityFile(id);
    }
    const result = await session.connect(builder.build());
    if (!isOk(result)) {
      this.addLine(`${user}@${host}: Permission denied (publickey,password).`, 'error');
      this.notify();
      return null;
    }
    return session;
  }

  /** Best-effort MOTD fetch via a one-shot remote `cat /etc/motd`. */
  private async tryReadRemoteMotd(session: SshSession): Promise<string[]> {
    const channelResult = session.openExecChannel('cat /etc/motd 2>/dev/null');
    if (!isOk(channelResult)) return [];
    const channel = channelResult.value;
    const result = await channel.execute();
    channel.close();
    return result.stdout ? result.stdout.replace(/\n$/, '').split('\n') : [];
  }

  /**
   * Banner composition for the fallback exec-channel path (synthetic SSH
   * handlers in tests). Mirrors `composeLoginBanner` ordering: Welcome →
   * motd → blank → Last login. Uses ssh exec commands because we do not
   * have direct access to the remote VFS.
   */
  private async composeLoginBannerViaExec(
    session: SshSession,
    user: string,
  ): Promise<string[]> {
    const lines: string[] = [];
    // Single source-of-truth for the Welcome line: motd if it has one,
    // otherwise a synthesised line from /etc/os-release. Avoids the
    // "Welcome to Ubuntu" duplicate (terminal_gap.md §9.2) that occurred
    // when the remote already had a motd that began with that line.
    const motd = await this.tryReadRemoteMotd(session);
    if (motd.length > 0 && motd.some((l) => l.trim().length > 0)) {
      for (const m of motd) lines.push(m);
    } else {
      const welcome = await this.tryReadWelcome(session);
      if (welcome) lines.push(welcome);
    }
    const lastLogin = await this.tryReadLastLogin(session, user);
    if (lastLogin) {
      if (lines.length > 0) lines.push('');
      lines.push(lastLogin);
    }
    return lines;
  }

  /**
   * Compose the canonical Ubuntu "Welcome to …" banner from /etc/os-release
   * + uname. Falls back to a generic string if the remote does not surface
   * those files.
   */
  private async tryReadWelcome(session: SshSession): Promise<string | null> {
    const ch = session.openExecChannel(
      'sh -c "grep PRETTY_NAME /etc/os-release 2>/dev/null; uname -r 2>/dev/null"',
    );
    if (!isOk(ch)) return null;
    const r = await ch.value.execute();
    ch.value.close();
    const out = r.stdout || '';
    const pretty = /PRETTY_NAME="([^"]+)"/.exec(out)?.[1];
    const release = out.split('\n').find((l) => /^\d+\./.test(l)) ?? '';
    if (!pretty && !release) return null;
    const machine = 'GNU/Linux';
    const arch = 'x86_64';
    return `Welcome to ${pretty ?? 'Ubuntu'} (${machine} ${release || '5.15.0'} ${arch})`;
  }

  /**
   * Generic sub-shell key handler.
   * Works for SQL*Plus and any future ISubShell implementations.
   */
  private handleSubShellKey(e: KeyEvent): boolean {
    if (!this.activeSubShell) return false;

    if (e.key === 'Enter') {
      const line = this._inputBuf;
      this._inputBuf = '';
      this.subShellHistoryIndex = -1;
      this.subShellSavedInput = '';
      this.addLine(`${this.activeSubShell.getPrompt()}${line}`);

      // Push non-empty lines to sub-shell history
      if (line.trim()) {
        this.subShellHistory = [...this.subShellHistory.slice(-199), line];
      }

      const maybePromise = this.activeSubShell.processLine(line);

      const applyResult = (result: import('@/terminal/subshells/ISubShell').SubShellResult) => {
        // Handle clear screen signal from sub-shell
        if (result.clearScreen) {
          this.clear();
        }

        for (const outputLine of result.output) this.addLine(outputLine);

        if (result.exit) {
          this.exitSubShell();
          return;
        }
        this.notify();
      };

      if (maybePromise instanceof Promise) {
        maybePromise.then(applyResult);
      } else {
        applyResult(maybePromise);
      }
      return true;
    }

    // Arrow Up → sub-shell history previous
    if (e.key === 'ArrowUp') {
      if (this.subShellHistory.length === 0) return true;
      if (this.subShellHistoryIndex === -1) {
        this.subShellSavedInput = this._inputBuf;
        this.subShellHistoryIndex = this.subShellHistory.length - 1;
      } else if (this.subShellHistoryIndex > 0) {
        this.subShellHistoryIndex--;
      }
      this._inputBuf = this.subShellHistory[this.subShellHistoryIndex] || '';
      this.notify();
      return true;
    }

    // Arrow Down → sub-shell history next
    if (e.key === 'ArrowDown') {
      if (this.subShellHistoryIndex === -1) return true;
      const idx = this.subShellHistoryIndex + 1;
      if (idx >= this.subShellHistory.length) {
        this.subShellHistoryIndex = -1;
        this._inputBuf = this.subShellSavedInput;
        this.subShellSavedInput = '';
      } else {
        this.subShellHistoryIndex = idx;
        this._inputBuf = this.subShellHistory[idx] || '';
      }
      this.notify();
      return true;
    }

    // Ctrl+L → clear screen
    if (e.key === 'l' && e.ctrlKey) {
      this.clear();
      this.notify();
      return true;
    }

    if (e.key === 'c' && e.ctrlKey) {
      this._inputBuf = '';
      this.subShellHistoryIndex = -1;
      this.addLine(`${this.activeSubShell.getPrompt()}^C`);
      this.notify();
      return true;
    }

    if (e.key === 'd' && e.ctrlKey) {
      this.exitSubShell();
      return true;
    }

    // Let the view handle other keys (typing into the interactive-text input)
    return false;
  }

  private exitSubShell(): void {
    if (this.activeSubShell) {
      this.activeSubShell.dispose();
      this.activeSubShell = null;
    }
    this._inputBuf = '';
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    this.subShellSavedInput = '';
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  // ── SSH device push/pop (BRD SSH-04) ───────────────────────────

  /**
   * Switch the terminal to operate on a remote device. Saves the
   * current device + cwd + user on a stack, swaps to the remote, runs
   * `onConnected` (typically: print MOTD + Last login), and notifies.
   *
   * The terminal stays in normal bash mode — every subsequent command
   * is dispatched against the remote `LinuxMachine.executeCommand`,
   * editors open on the remote, tab completion uses the remote VFS.
   */
  pushRemoteDevice(
    remote: Equipment,
    user: string,
    label: string,
    onPop: () => void = () => undefined,
  ): void {
    // Stash the previous device + the local shell session, then allocate a
    // fresh shell session on the remote so commands executed during the SSH
    // chain run with the remote user's home / env / suStack — not the local
    // one. On pop we close that remote session and restore the local pair.
    const pausedShell = this.shell;
    let remoteShell: LinuxShellSession | null = null;
    if (remote instanceof LinuxMachine) {
      remoteShell = remote.openShellSession({ user });
    }
    this.sshStack.push({
      device: this.device,
      user: this.currentUser,
      path: this.currentPath,
      pausedShell,
      onPop: () => {
        if (remoteShell && remote instanceof LinuxMachine) {
          remote.closeShellSession(remoteShell);
        }
        try { onPop(); } catch { /* swallow */ }
      },
      label,
    });
    this.device = remote;
    this.shell = remoteShell;
    this.currentUser = user;
    this.currentPath = remoteShell?.cwd ?? remote.getCwd() ?? `/home/${user}`;
    this.notify();
  }

  /**
   * Restore the previous device. Prints "logout / Connection to <host>
   * closed." and runs the saved `onPop` (e.g. SshSession.disconnect).
   */
  popRemoteDevice(): void {
    const frame = this.sshStack.pop();
    if (!frame) return;
    try {
      frame.onPop();
    } catch {
      /* ignore teardown errors */
    }
    this.addLine('logout');
    this.addLine(`Connection to ${frame.label} closed.`);
    this.device = frame.device;
    this.shell = frame.pausedShell;
    this.currentUser = frame.user;
    this.currentPath = frame.path;
    this.notify();
  }

  /** True while the terminal is operating on a remote device. */
  get isInsideSshSession(): boolean {
    return this.sshStack.length > 0;
  }

  /**
   * OpenSSH `ssh -J <hops>` ProxyJump support. Pushes one SSH stack
   * frame per hop in order, resolving each `host` to a local Equipment
   * via the SSH-LAN registry. Returns `false` (and rolls back) if any
   * hop fails to resolve.
   *
   * For the simulator, "connecting" to a LAN-local device is the same
   * as pushing it on the stack — the underlying SSH session is what
   * `connectAndEnterSsh` opens afterwards for the final hop. Each hop
   * defaults its user to the previous hop's user when omitted.
   */
  /**
   * Register `-L localPort:remoteHost:remotePort` forwarders on the local
   * device for every entry in `meta.localForwards`. Returns the list of
   * registered forwarders so the caller can dispose them when the SSH
   * session ends.
   */
  private installLocalForwards(
    session: SshSession,
    sshHost: string,
    meta: { localForwards?: readonly LocalForward[] },
  ): SshLocalForwarder[] {
    const forwards = meta.localForwards ?? [];
    if (forwards.length === 0) return [];
    const localDevice = this.getLocalDevice() as unknown as
      import('@/network/devices/EndHost').EndHost;
    if (typeof (localDevice as { listenTcp?: unknown }).listenTcp !== 'function') {
      return [];
    }
    const out: SshLocalForwarder[] = [];
    for (const fwd of forwards) {
      const forwarder = new SshLocalForwarder(localDevice, session, {
        localPort: fwd.localPort,
        remoteHost: fwd.remoteHost,
        remotePort: fwd.remotePort,
        sshHost,
      });
      forwarder.register();
      this.addLine(
        `Forwarding TCP ${fwd.localPort} → ${fwd.remoteHost}:${fwd.remotePort} via ${sshHost}`,
      );
      out.push(forwarder);
    }
    return out;
  }

  /**
   * Register `-D socksPort` SOCKS proxies on the local device. Each one
   * accepts SOCKS5 CONNECT requests and bridges through the SSH session.
   */
  private installDynamicForwards(
    session: SshSession,
    sshHost: string,
    meta: { dynamicForwards?: readonly DynamicForward[] },
  ): SshDynamicForwarder[] {
    const forwards = meta.dynamicForwards ?? [];
    if (forwards.length === 0) return [];
    const localDevice = this.getLocalDevice() as unknown as
      import('@/network/devices/EndHost').EndHost;
    if (typeof (localDevice as { listenTcp?: unknown }).listenTcp !== 'function') {
      return [];
    }
    const out: SshDynamicForwarder[] = [];
    for (const fwd of forwards) {
      const forwarder = new SshDynamicForwarder(localDevice, session, {
        socksPort: fwd.socksPort,
        bindAddress: fwd.bindAddress,
        sshHost,
      });
      forwarder.register();
      this.addLine(
        `SOCKS proxy listening on ${fwd.bindAddress ?? '*'}:${fwd.socksPort} via ${sshHost}`,
      );
      out.push(forwarder);
    }
    return out;
  }

  /**
   * Mirror of {@link installLocalForwards} for `-R`. Each entry opens
   * a listener on the *remote* device for `remotePort`. Returns the
   * list of registered forwarders so the caller can dispose them
   * when the SSH session ends.
   */
  private installRemoteForwards(
    session: SshSession,
    sshHost: string,
    remoteDeviceRaw: Equipment,
    meta: { remoteForwards?: readonly RemoteForward[] },
  ): SshRemoteForwarder[] {
    const forwards = meta.remoteForwards ?? [];
    if (forwards.length === 0) return [];
    const remoteDevice = remoteDeviceRaw as unknown as
      import('@/network/devices/EndHost').EndHost;
    if (typeof (remoteDevice as { listenTcp?: unknown }).listenTcp !== 'function') {
      return [];
    }
    const out: SshRemoteForwarder[] = [];
    for (const fwd of forwards) {
      const forwarder = new SshRemoteForwarder(remoteDevice, session, {
        remotePort: fwd.remotePort,
        localHost: fwd.localHost,
        localPort: fwd.localPort,
        sshHost,
      });
      forwarder.register();
      this.addLine(
        `Forwarding ${sshHost}:${fwd.remotePort} → ${fwd.localHost}:${fwd.localPort} (reverse)`,
      );
      out.push(forwarder);
    }
    return out;
  }

  /**
   * Wire OpenSSH `-A` agent forwarding: copy the local device's
   * SshAgent into the remote device's SshAgent. Both ends look up
   * their agent via the executor (LinuxCommandExecutor exposes
   * `sshAgent`). Returns null when forwarding is disabled or either
   * end is not a fully-fledged LinuxPC.
   */
  private installAgentForwarding(
    remoteDeviceRaw: Equipment,
    meta: { forwardAgent?: boolean },
  ): SshAgentForwarding | null {
    if (!meta.forwardAgent) return null;
    const localExec = (this.getLocalDevice() as unknown as {
      executor?: { sshAgent?: import('@/network/protocols/ssh/SshAgent').SshAgent };
    }).executor;
    const remoteExec = (remoteDeviceRaw as unknown as {
      executor?: { sshAgent?: import('@/network/protocols/ssh/SshAgent').SshAgent };
    }).executor;
    if (!localExec?.sshAgent || !remoteExec?.sshAgent) return null;
    const fwd = new SshAgentForwarding(localExec.sshAgent, remoteExec.sshAgent);
    fwd.attach();
    return fwd;
  }

  pushSshChain(hops: readonly ProxyHop[]): boolean {
    const pushed: number[] = [];
    let inheritedUser = this.currentUser;
    for (const hop of hops) {
      const remote = findLinuxMachineByIp(hop.host);
      if (!remote) {
        // Roll back any successful hops so the stack is unchanged.
        for (let i = 0; i < pushed.length; i++) this.popRemoteDevice();
        return false;
      }
      const user = hop.user ?? inheritedUser;
      const label = `${user}@${hop.host}`;
      this.pushRemoteDevice(remote, user, label, () => undefined);
      pushed.push(1);
      inheritedUser = user;
    }
    return true;
  }

  /**
   * Snapshot of the SSH stack for the UI layer. Returns one entry per
   * pushed remote, oldest first; `current` is the active host name. The
   * UI uses this to render an "SSH connected to <host>" banner so the
   * user always sees they are not on their local machine even though
   * the prompt and tab-completion now mirror the remote.
   */
  getSshContextInfo(): {
    active: boolean;
    chain: readonly { host: string; user: string }[];
    current: string | null;
  } {
    const chain = this.sshStack.map((f) => {
      const at = f.label.indexOf('@');
      return at >= 0
        ? { host: f.label.slice(at + 1), user: f.label.slice(0, at) }
        : { host: f.label, user: f.user };
    });
    const current = chain.length > 0 ? chain[chain.length - 1].host : null;
    return {
      active: chain.length > 0,
      chain,
      current,
    };
  }
}

// ── IP → device resolver (BRD SSH-04) ───────────────────────────

/**
 * Look up the LinuxMachine whose any port is bound to the given IPv4.
 * Used by `connectAndEnterSsh` to switch the terminal's `device` to the
 * remote machine without touching the simulated SSH transport. Returns
 * null when the target is not a Linux device managed by the sandbox.
 */
function findLinuxMachineByIp(targetIp: string): Equipment | null {
  // Equipment.getAllEquipment is a static singleton registry filled when
  // device classes get instantiated. We avoid importing LinuxMachine /
  // EndHost types here to dodge a circular import; duck-typing is fine.
  const all = (Equipment as unknown as { getAllEquipment: () => Equipment[] })
    .getAllEquipment();
  for (const eq of all) {
    const portsObj = (eq as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
    if (!portsObj) continue;
    for (const port of portsObj.values()) {
      const ip = port.getIPAddress?.();
      if (ip && ip.toString() === targetIp) {
        // Only meaningful for Linux-flavoured devices that expose the
        // executor pipeline; check duck-typed shape.
        if (typeof (eq as unknown as { executeCommand?: unknown }).executeCommand === 'function') {
          return eq;
        }
      }
    }
  }
  return null;
}

/**
 * Compose the post-authentication banner the way OpenSSH does (with PAM
 * configured the Ubuntu way):
 *   1. "Welcome to Ubuntu <pretty-name> (GNU/Linux <release> <arch>)"
 *   2. Contents of /etc/motd (if non-empty)
 *   3. Blank line separator
 *   4. "Last login: …" pulled from the in-memory lastlog registry
 *
 * Honours `~/.hushlogin`: if the user's home contains it, no banner is
 * emitted — matches PAM behaviour exactly.
 */
function composeLoginBanner(remote: Equipment, user: string): string[] {
  const exec = (remote as unknown as {
    executor?: {
      vfs?: { readFile: (p: string) => string | null };
      lastlog?: {
        getPrevious: (u: string) => { when: number; sourceHost: string; tty: string } | undefined;
      };
      userMgr?: { getUser: (u: string) => { home?: string } | undefined };
    };
  }).executor;
  if (!exec?.vfs) return [];

  const home = exec.userMgr?.getUser(user)?.home ?? `/home/${user}`;
  // /etc/nologin: refuse non-root logins. Conventional Ubuntu honors it via PAM.
  // /etc/motd:    static-motd. /etc/legal: not surfaced by default sshd.
  // ~/.hushlogin: suppress all banner content (motd + lastlog).
  const hushLogin = exec.vfs.readFile(`${home}/.hushlogin`);
  if (hushLogin !== null) return [];

  const lines: string[] = [];

  // Single "Welcome to …" line — sourced ONCE.
  //
  // Ubuntu provisions /etc/motd at LinuxMachine setup time (LinuxMachine.ts:
  // ~line 160) with the canonical line baked in. If the machine has a
  // motd, use that as the authoritative source. If not, synthesise a
  // fallback from /etc/os-release so unconfigured machines still get
  // a banner. Either way the line appears exactly once
  // (terminal_gap.md §9.2).
  const motdRaw = (exec.vfs.readFile('/etc/motd') ?? '').replace(/\n+$/, '');
  if (motdRaw.trim().length > 0) {
    for (const m of motdRaw.split('\n')) lines.push(m);
  } else {
    const osRelease = exec.vfs.readFile('/etc/os-release') ?? '';
    const pretty = /PRETTY_NAME="([^"]+)"/.exec(osRelease)?.[1] ?? 'Ubuntu 22.04 LTS';
    lines.push(`Welcome to ${pretty} (GNU/Linux 5.15.0-91-generic x86_64)`);
  }

  const prev = exec.lastlog?.getPrevious(user);
  if (prev) {
    lines.push('');
    // Ctime format identical to pam_lastlog.so.
    const d = new Date(prev.when);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const ctime =
      `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ` +
      `${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:` +
      `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
      `${d.getUTCFullYear()}`;
    lines.push(`Last login: ${ctime} from ${prev.sourceHost}`);
  }

  return lines;
}

// ── ssh CLI argument parser ─────────────────────────────────────

// ── Shell-chain parsing (used by the editor-in-chain dispatcher) ──────

/**
 * Split a command line on top-level `&&`, `||`, and `;` operators while
 * respecting quotes (single, double) and escapes. Operators inside
 * quoted strings are ignored — exactly the semantics POSIX shells use.
 *
 * Returns segments paired with the connector that ties the segment to
 * its predecessor (`;` for the first segment, meaning "run unconditionally").
 *
 * Pipes (`|`) and process substitutions are left embedded in the segment
 * — only conditional/sequence chaining matters for the editor flow.
 */
export function parseShellChain(
  line: string,
): Array<{ connector: ';' | '&&' | '||'; cmd: string }> {
  const segments: Array<{ connector: ';' | '&&' | '||'; cmd: string }> = [];
  let cur = '';
  let connector: ';' | '&&' | '||' = ';';
  let quote: '"' | "'" | null = null;
  let escape = false;

  const push = () => {
    const cmd = cur.trim();
    if (cmd.length > 0) segments.push({ connector, cmd });
    cur = '';
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (escape) { cur += c; escape = false; continue; }
    if (c === '\\' && quote !== "'") { cur += c; escape = true; continue; }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { cur += c; quote = c; continue; }

    // Operators outside quotes.
    if (c === '&' && line[i + 1] === '&') {
      push();
      connector = '&&';
      i++;
      continue;
    }
    if (c === '|' && line[i + 1] === '|') {
      push();
      connector = '||';
      i++;
      continue;
    }
    if (c === ';') {
      push();
      connector = ';';
      continue;
    }
    cur += c;
  }
  push();
  return segments;
}

/** Is this segment a `nano`/`vi`/`vim` invocation (with or without sudo)? */
export function isEditorSegment(segment: string): boolean {
  const noSudo = segment.startsWith('sudo ') ? segment.slice(5).trimStart() : segment;
  const head = noSudo.split(/\s+/, 1)[0];
  return head === 'nano' || head === 'vi' || head === 'vim';
}

/** Connector gating: should this segment run given the previous exit code? */
export function shouldExecuteSegment(
  connector: ';' | '&&' | '||',
  previousExitCode: number,
): boolean {
  if (connector === ';') return true;
  if (connector === '&&') return previousExitCode === 0;
  return previousExitCode !== 0;
}

function hasSftpError(output: readonly string[]): boolean {
  return output.some((line) =>
    /Couldn't|No such file|Permission denied|Failure|invalid|command not found/i.test(
      line,
    ),
  );
}

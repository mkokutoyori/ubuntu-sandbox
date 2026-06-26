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

import { Equipment, type HostCapableDevice } from '@/network';
import { parsePingArgs } from '@/network/devices/linux/commands/net/Ping';
import { parseTracerouteArgs } from '@/network/devices/linux/commands/net/Traceroute';
import { parseWatchArgs } from '@/network/devices/linux/coreutils/WatchRunner';
import { parseIpMonitorSpec } from '@/network/devices/linux/LinuxIpCommand';
import { parseInvocation } from '@/network/devices/linux/network/tcpdump/TcpdumpCli';
import { compileFilter } from '@/network/devices/linux/network/tcpdump/TcpdumpFilter';
import { banner as tcpdumpBanner, footer as tcpdumpFooterLines, formatFrame as formatCaptureFrame } from '@/network/devices/linux/network/tcpdump/TcpdumpFormat';
import { formatPingHeader, formatPingReplyLine, formatPingStats, formatTracerouteHeader, formatTracerouteHopLine } from '@/network/devices/linux/LinuxFormatHelpers';
import type { PingResult } from '@/network/devices/EndHost';
import type { AsyncJobContext } from '@/terminal/async';
import { primaryShellKindFor } from '@/shell/shellKind';
import {
  TerminalSession, TerminalTheme, SessionType,
  KeyEvent, InputMode, withTimeout, DeviceOfflineError,
} from './TerminalSession';
import { createSessionForDevice } from './sessionFactory';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { AnsiOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { completeInput } from '@/terminal/core/TabCompletionHelper';
import { LinuxFlowBuilder } from '@/terminal/flows/LinuxFlowBuilder';
import {
  parseReadInvocation as parseReadInvocationLib,
  performInteractiveRead as performInteractiveReadLib,
  PromiseInputBroker as PromiseInputBrokerLib,
} from '@/shell/input';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman/ReactiveRmanSubShell';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import { RemoteShellSubShell } from '@/terminal/subshells/RemoteShellSubShell';
import { installDefaultShells } from '@/shell/registerDefaults';
import { ShellFactory } from '@/shell/ShellFactory';
import { ShellSubShellAdapter } from '@/shell/ShellSubShellAdapter';
import { LinuxBashShell } from '@/shell/adapters/LinuxBashShell';
import { ShellContext } from '@/shell/ShellContext';
import { CrossVendorRemoteShell } from '@/shell/CrossVendorRemoteShell';
import { SqlPlusShell } from '@/shell/adapters/SqlPlusShell';
import { RmanShell } from '@/shell/adapters/RmanShell';
import {
  LinuxPromptStrategy as LinuxStrategyRef,
  CiscoPromptStrategy as CiscoStrategyRef,
  HuaweiPromptStrategy as HuaweiStrategyRef,
  WindowsPromptStrategy as WindowsStrategyRef,
} from '@/terminal/subshells/RemoteDeviceSubShell';
import {
  RemoteDeviceSubShell,
  CiscoPromptStrategy, HuaweiPromptStrategy, WindowsPromptStrategy,
  strategyForShellKind,
  type RemotePromptStrategy,
} from '@/terminal/subshells/RemoteDeviceSubShell';
import { SshConnectionRequest } from '@/network/protocols/ssh/server/SshConnectionRequest';
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

  /**
   * Top of the active shell stack — for IShellBase introspection. When
   * a sub-shell (sqlplus, rman, sftp, SSH push) is pushed, surface it;
   * otherwise null (native bash is driven inline by the session for
   * historical reasons, predating the IShell layer).
   */
  override get activeShell(): import('@/shell/IShellBase').IShellBase | null {
    return this.activeSubShell;
  }
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

  /**
   * Local-bash IShell instance the session delegates plain-command
   * execution to. Created lazily so the per-terminal LinuxShellSession
   * (which holds cwd / env / suStack / lastExitCode) is already
   * allocated; shares the session by passing `preexistingSession` so
   * cwd updates propagate seamlessly between the legacy path and the
   * shell-driven path. Null when the underlying device is not a
   * `LinuxMachine` (synthetic test doubles).
   */
  private rootBash: LinuxBashShell | null = null;
  /** Pending input asked for by the root bash shell (nested ssh password). */
  private rootBashPendingInput: { kind: 'password' | 'text'; promptText: string } | null = null;

  private ensureRootBash(): LinuxBashShell | null {
    if (!(this.device instanceof LinuxMachine) || !this.shell) return null;
    // Re-create when the bound session no longer matches the active one —
    // this is what happens after `pushRemoteDevice` swaps `this.shell` to
    // a remote session. The previous instance is disposed (no-op on the
    // session itself: it doesn't own it) so its internal state is freed.
    const sessionDrifted = this.rootBash !== null
      && (this.rootBash as unknown as { session: LinuxShellSession | null }).session !== this.shell;
    if (this.rootBash && !sessionDrifted) return this.rootBash;
    if (this.rootBash && sessionDrifted) {
      this.rootBash.deactivate();
      this.rootBash.dispose();
      this.rootBash = null;
    }
    const creds = this.shell.user === 'root'
      ? ShellContext.rootCredentials()
      : ShellContext.userCredentials(this.shell.user);
    const ctx = new ShellContext(
      this.device.getHostname?.() ?? 'localhost',
      creds,
      this.shell.cwd,
    );
    this.rootBash = new LinuxBashShell({
      device: this.device,
      user: this.shell.user,
      context: ctx,
      connection: 'console',
      preexistingSession: this.shell,
      ownsSession: false,
    });
    this.rootBash.setInputHost(this.getInputHost());
    this.rootBash.activate();
    return this.rootBash;
  }

  /**
   * Push an IShell as the session's active sub-shell, wrapping it in a
   * ShellSubShellAdapter so the legacy stack mechanics (handleSubShellKey,
   * sub-shell history) keep working unchanged.
   */
  private pushIShellAsSubShell(child: import('@/shell').IShell): void {
    if (typeof child.setInputHost === 'function') child.setInputHost(this.getInputHost());
    const adapter = new ShellSubShellAdapter(child);
    if (this.activeSubShell) this.iShellSubStack.push(this.activeSubShell);
    this.activeSubShell = adapter;
    for (const line of child.getActivationBanner()) this.addLine(line);
    child.activate();
    this.notify();
  }

  /** Stack of paused sub-shells when nesting through bash-driven launches. */
  private iShellSubStack: import('@/terminal/subshells/ISubShell').ISubShell[] = [];

  /**
   * The pending input directive most recently requested by the active
   * sub-shell. Routes the next Enter to subshell.handleInput.
   */
  private subShellPendingInput: { kind: 'password' | 'text'; promptText: string } | null = null;

  /**
   * Forward a value the host collected after a pendingInput directive
   * to the active sub-shell's handleInput.
   */
  private async feedSubShellInput(value: string): Promise<void> {
    if (!this.activeSubShell || typeof this.activeSubShell.handleInput !== 'function') {
      this.notify(); return;
    }
    const result = await this.activeSubShell.handleInput(value);
    if (result.styledOutput && result.styledOutput.length > 0) {
      for (const styled of result.styledOutput) this.addStyledLine(styled.segments, styled.lineType);
    } else {
      for (const line of result.output) this.addLine(line);
    }
    if (result.exit) { this.exitSubShell(); return; }
    if (result.childShell) { this.pushIShellAsSubShell(result.childShell); return; }
    if (result.pendingInput) {
      this.subShellPendingInput = result.pendingInput;
      this.inputMode = result.pendingInput.kind === 'password'
        ? { type: 'password', promptText: result.pendingInput.promptText }
        : { type: 'interactive-text', promptText: result.pendingInput.promptText };
    }
    this.notify();
  }

  /**
   * Forward a value the host collected after a pendingInput directive
   * to the root bash shell's `handleInput`. Mirrors the apply logic of
   * executeCommand so the shell can either push a child (auth ok), ask
   * for another attempt (auth retry) or emit a final error.
   */
  private async feedRootBashInput(value: string): Promise<void> {
    const shell = this.rootBash;
    if (!shell || typeof shell.handleInput !== 'function') { this.notify(); return; }
    const result = await shell.handleInput(value);
    if (result.styledOutput && result.styledOutput.length > 0) {
      for (const styled of result.styledOutput) this.addStyledLine(styled.segments, styled.lineType);
    } else {
      for (const line of result.output) this.addLine(line);
    }
    if (result.childShell) { this.pushIShellAsSubShell(result.childShell); return; }
    if (result.pendingInput) {
      this.rootBashPendingInput = result.pendingInput;
      this.inputMode = result.pendingInput.kind === 'password'
        ? { type: 'password', promptText: result.pendingInput.promptText }
        : { type: 'interactive-text', promptText: result.pendingInput.promptText };
    }
    this.notify();
  }

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
      this.currentPath = this.device.getCwd?.() || '/home/user';
      this.currentUser = this.device.getCurrentUser?.() || 'user';
    }
  }

  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

  protected override getFlowUser(): string {
    return this.shell?.user ?? this.currentUser;
  }

  protected override applyRemoteEnv(env: Record<string, string>): void {
    const shellEnv = (this.shell as unknown as { env?: { set(k: string, v: string): void } } | null)?.env;
    if (!shellEnv) return;
    for (const [k, v] of Object.entries(env)) shellEnv.set(k, v);
  }

  protected override prepareAsRemoteUser(user: string): void {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) {
      this.currentUser = user;
      this.currentPath = `/home/${user}`;
      return;
    }
    if (this.shell) dev.closeShellSession(this.shell);
    this.shell = dev.openShellSession({ user });
    this.currentUser = user;
    this.currentPath = this.shell.cwd;
    if (this.rootBash) {
      this.rootBash.deactivate();
      this.rootBash.dispose();
      this.rootBash = null;
    }
  }

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
    if (this.hasActiveChild) return this.foreground.getPrompt();
    if (this.activeSubShell) return this.activeSubShell.getPrompt();
    const hostname = this.device.getHostname() || 'localhost';
    const user = this.currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = this.currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return `${user}@${hostname}:${path}${promptChar} `;
  }

  /**
   * Structured prompt parts for the colored prompt renderer. When the
   * session is currently driven by a foreign sub-shell (SSH'd into a
   * Windows / Cisco / Huawei host, or sitting in sqlplus / rman / sftp),
   * the bash-style `user@host:path$` segmentation does not apply —
   * `foreign: true` tells the renderer to ignore the parts and call
   * `getPrompt()` (which delegates to the active sub-shell) instead.
   */
  getPromptParts(): {
    user: string; hostname: string; path: string; promptChar: string;
    foreign?: boolean;
  } {
    if (this.activeSubShell) {
      const kind = (this.activeSubShell as { kind?: string; inner?: { kind?: string } }).kind
        ?? (this.activeSubShell as { inner?: { kind?: string } }).inner?.kind
        ?? '';
      // bash-emitting sub-shells (the SSH'd bash) keep the linux
      // user@host:path$ format because they ARE linux.
      const innerTop = this.subShellInnerTopKind();
      const effectiveKind = kind === 'ssh-remote' && innerTop ? innerTop : kind;
      const linuxLike = effectiveKind === '' || effectiveKind.includes('bash');
      if (!linuxLike) {
        return {
          user: this.currentUser,
          hostname: this.device.getHostname() || 'localhost',
          path: this.currentPath,
          promptChar: '$',
          foreign: true,
        };
      }
    }
    const hostname = this.device.getHostname() || 'localhost';
    const user = this.currentUser;
    const homeDir = user === 'root' ? '/root' : `/home/${user}`;
    let path = this.currentPath;
    if (path === homeDir) path = '~';
    else if (path.startsWith(homeDir + '/')) path = '~' + path.slice(homeDir.length);
    const promptChar = user === 'root' ? '#' : '$';
    return { user, hostname, path, promptChar };
  }

  /** Peek inside an SSH-remote adapter to learn the inner top-of-stack kind. */
  private subShellInnerTopKind(): string | null {
    const inner = (this.activeSubShell as { inner?: { topKind?: string; primaryKind?: string } }).inner;
    return inner?.topKind ?? inner?.primaryKind ?? null;
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
    // Linux terminal has no boot sequence — ready immediately. We
    // pre-register the default shells so bash's SUBSHELL_TRIGGERS find
    // the SqlPlus / RMAN / SFTP adapters when the user invokes them.
    installDefaultShells();
  }

  // ── Input mode ──────────────────────────────────────────────────

  override get currentInputMode(): InputMode {
    if (this.hasActiveChild) return this.foreground.currentInputMode;
    if (this.inputHostImpl.hasPendingRequest()
        && (this.inputMode.type === 'password' || this.inputMode.type === 'interactive-text')) {
      return this.inputMode;
    }
    // Reactive SSH IO takes priority: the SSH layer is waiting for user input
    // (password or host-key confirmation). inputMode is set by the IO adapter's
    // beginPrompt(), so just returning it is enough — but we gate here first so
    // handleKey() can route to handleSshIOKey() before any flow/sub-shell check.
    if (this.pendingSshIO?.isWaitingForInput) {
      return this.inputMode;
    }
    // Pending password / text driven by a sub-shell or by the root bash:
    // those take priority over the regular interactive-text mode so the
    // view masks keystrokes for a password challenge.
    if (this.activeSubShell && this.subShellPendingInput) {
      const p = this.subShellPendingInput;
      return p.kind === 'password'
        ? { type: 'password', promptText: p.promptText }
        : { type: 'interactive-text', promptText: p.promptText };
    }
    if (this.rootBashPendingInput) {
      const p = this.rootBashPendingInput;
      return p.kind === 'password'
        ? { type: 'password', promptText: p.promptText }
        : { type: 'interactive-text', promptText: p.promptText };
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

    if (this.hasActiveChild) return this.foreground.handleKey(e);

    if (this.inputHostImpl.hasPendingRequest()) {
      if (this.handleBrokerKey(e)) return true;
    }

    // Reactive SSH IO: the SSH layer is awaiting user input (password or
    // host-key confirmation). Handle Enter/Ctrl+C here; everything else
    // falls through to the view's input element (character typing).
    if (this.pendingSshIO?.isWaitingForInput) {
      return this.handleSshIOKey(e);
    }

    // Root-bash asked for a password / text value (nested ssh launched
    // from the local console). Enter feeds the value back through
    // shell.handleInput, Ctrl+C cancels.
    if (this.rootBashPendingInput) {
      if (e.key === 'Enter') {
        const value = this.rootBashPendingInput.kind === 'password'
          ? this.getPasswordBuf() : this.getInputBuf();
        const directive = this.rootBashPendingInput;
        this.rootBashPendingInput = null;
        this.setPasswordBuf('');
        this.setInputBuf('');
        this.inputMode = { type: 'normal' };
        if (directive.kind === 'password' && directive.promptText) {
          this.addLine(directive.promptText);
        }
        void this.feedRootBashInput(value);
        return true;
      }
      if (e.key === 'c' && e.ctrlKey) {
        this.rootBashPendingInput = null;
        this.setPasswordBuf('');
        this.setInputBuf('');
        this.inputMode = { type: 'normal' };
        this.addLine('^C');
        this.notify();
        return true;
      }
      return false; // let the view drive char-by-char input
    }

    // Sub-shell asked for a pending input value (typically a nested ssh
    // password). Capture it via password/text mode and feed it back to
    // the sub-shell's handleInput on Enter. Ctrl+C aborts.
    if (this.activeSubShell && this.subShellPendingInput) {
      if (e.key === 'Enter') {
        const value = this.subShellPendingInput.kind === 'password'
          ? this.getPasswordBuf() : this.getInputBuf();
        const directive = this.subShellPendingInput;
        this.subShellPendingInput = null;
        this.setPasswordBuf('');
        this.setInputBuf('');
        this.inputMode = { type: 'normal' };
        if (directive.kind === 'password' && directive.promptText) {
          this.addLine(directive.promptText);
        }
        void this.feedSubShellInput(value);
        return true;
      }
      if (e.key === 'c' && e.ctrlKey) {
        this.subShellPendingInput = null;
        this.setPasswordBuf('');
        this.setInputBuf('');
        this.inputMode = { type: 'normal' };
        this.addLine('^C');
        this.notify();
        return true;
      }
      return false;
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

    if (e.key === 'd' && e.ctrlKey && this.input === '') {
      if (this.endRemoteSession()) return true;
      if (this.sshStack.length > 0) { this.popRemoteDevice(); return true; }
      this._onRequestClose?.();
      return true;
    }

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
    // While a `tail -f` stream is active, Enter just emits a blank line
    // (matching real bash behaviour); the only way out is Ctrl+C.
    if (this.hasForegroundAsyncJob) {
      this.addLine('');
      this.input = '';
      this.notify();
      return;
    }
    // Drain BOTH input buffers — `this.input` is the canonical local
    // console buffer, `_inputBuf` is the sub-shell buffer. When a
    // sub-shell unwinds back to the root bash, programmatic drivers /
    // tests that keep using `setInputBuf` should still reach the local
    // shell instead of being silently dropped. Real interactive use
    // only fills one buffer at a time; the OR is a no-op there.
    const cmd = this.input || this._inputBuf;
    this.input = '';
    this._inputBuf = '';
    this.tabSuggestions = null;
    // The 'input' record event is emitted by addEchoLine inside
    // executeCommand — recording here too would duplicate every typed
    // command in the session transcript.
    this.executeCommand(cmd);
    this.notify();
  }

  /**
   * Detect `tail -f` / `tail -F` and, on a match, open a follow stream
   * whose sink pumps appended file content through `addLine` so React
   * re-renders pick it up live. Returns `true` when a stream was opened
   * (caller must stop processing this command); `false` for any other
   * input. Falls back silently when the device is not a LinuxMachine or
   * no shell session is allocated.
   */
  private tryStartTailStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    const shell = this.shell;
    let handle: import('@/network/devices/linux/coreutils').TailFollowHandle | null = null;
    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      prepare: (ctx) => {
        handle = dev.startTailFollowInSession(commandLine, shell, {
          write: (chunk) => ctx.sink.write(chunk),
          warn:  (msg)   => ctx.sink.error(msg),
          error: (msg)   => ctx.sink.error(msg),
        });
        if (!handle) return false;
        ctx.onCancel(() => handle?.cancel());
        return true;
      },
      run: (ctx) => new Promise<void>((resolve) => {
        if (ctx.cancelled()) { resolve(); return; }
        ctx.onCancel(() => resolve());
      }),
    });
    return job !== null;
  }

  private tryStartPingStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'ping') return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const parsed = parsePingArgs(toks.slice(1), 'ping');
    if (!parsed.targetStr || parsed.v6) return false;

    let targetLabel = parsed.targetStr;
    const results: PingResult[] = [];
    const emitStats = (ctx: AsyncJobContext) => {
      for (const line of formatPingStats(targetLabel, results.length, results)) ctx.sink.line(line);
    };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        const outcome = await dev.pingStreamInSession(parsed.targetStr, {
          count: parsed.count,
          timeoutMs: parsed.timeoutMs,
          ttl: parsed.ttl,
          intervalMs: parsed.intervalMs,
          onResolved: (ip) => { targetLabel = ip.toString(); ctx.sink.line(formatPingHeader(ip, parsed.size, parsed.targetStr !== ip.toString() ? parsed.targetStr : undefined)); },
          onResult: (r) => { results.push(r); const line = formatPingReplyLine(r, parsed.size); if (line !== null) ctx.sink.line(line); },
          shouldStop: () => ctx.cancelled(),
          sleep: (ms) => ctx.delay(ms),
        });
        if (ctx.cancelled()) return;
        if (!outcome.resolved && results.length === 0) {
          ctx.sink.error(outcome.reason === 'name'
            ? `ping: ${parsed.targetStr}: Name or service not known`
            : 'ping: connect: Network is unreachable');
          return;
        }
        emitStats(ctx);
      },
      onInterrupt: (ctx) => emitStats(ctx),
    });
    return job !== null;
  }

  private tryStartTracerouteStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'traceroute') return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const parsed = parseTracerouteArgs(toks.slice(1));
    if (!parsed.targetStr) return false;

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        let hopCount = 0;
        const outcome = await dev.tracerouteStreamInSession(parsed.targetStr, {
          maxHops: parsed.maxHops,
          probesPerHop: parsed.probesPerHop,
          firstTtl: parsed.firstTtl,
          onResolved: (ip, hostname) => ctx.sink.line(formatTracerouteHeader(ip, parsed.maxHops, hostname)),
          onHop: (hop) => { hopCount++; ctx.sink.line(formatTracerouteHopLine(hop)); },
          shouldStop: () => ctx.cancelled(),
        });
        if (ctx.cancelled()) return;
        if (!outcome.resolved) { ctx.sink.error(`traceroute: unknown host ${parsed.targetStr}`); return; }
        if (hopCount === 0) ctx.sink.line(' * * * Network is unreachable');
      },
    });
    return job !== null;
  }

  private startRepaintingMonitor(commandLine: string, intervalMs: number): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    const shell = this.shell;
    let baseLen = this.lines.length;

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      prepare: () => { baseLen = this.lines.length; return true; },
      run: async (ctx) => {
        while (!ctx.cancelled()) {
          const frame = dev.runCommandFrameInSession(commandLine, shell);
          this.lines = this.lines.slice(0, baseLen);
          for (const line of frame.split('\n')) this.addLine(line);
          this.notify();
          await ctx.delay(intervalMs);
        }
      },
    });
    return job !== null;
  }

  private tryStartWatchStream(commandLine: string): boolean {
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'watch') return false;
    let parsed: ReturnType<typeof parseWatchArgs>;
    try { parsed = parseWatchArgs(toks.slice(1)); } catch { return false; }
    if (parsed.command.length === 0) return false;
    return this.startRepaintingMonitor(commandLine, Math.max(100, parsed.intervalSeconds * 1000));
  }

  private tryStartTopStream(commandLine: string): boolean {
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'top') return false;
    if (toks.includes('-n') || toks.includes('-b')) return false;
    const dIdx = toks.indexOf('-d');
    const delay = dIdx >= 0 ? parseFloat(toks[dIdx + 1]) : 3;
    const intervalMs = Math.max(100, (Number.isFinite(delay) && delay > 0 ? delay : 3) * 1000);
    return this.startRepaintingMonitor(commandLine, intervalMs);
  }

  private tryStartTcpdump(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'tcpdump') return false;
    if (/[|<>]/.test(commandLine)) return false;

    const inv = parseInvocation(toks.slice(1));
    if (inv.kind !== 'capture' || inv.options.readFile || inv.options.writeFile) {
      const job = this.startAsyncCommand({
        mode: 'foreground',
        kind: 'streaming',
        command: commandLine,
        prepare: () => true,
        run: async (ctx) => {
          const out = await dev.executeCommand(commandLine);
          if (out) for (const l of out.split('\n')) ctx.sink.line(l);
        },
      });
      return job !== null;
    }

    const opts = inv.options;
    const filter = compileFilter(opts.filterTokens);
    let captured = 0;
    let prev: Date | null = null;
    let unsubscribe: (() => void) | null = null;
    const footer = (ctx: AsyncJobContext) => { for (const l of tcpdumpFooterLines(captured, captured)) ctx.sink.line(l); };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      prepare: (ctx) => {
        if (filter.ok === false) { ctx.sink.line(filter.message); return false; }
        for (const h of tcpdumpBanner(opts)) ctx.sink.line(h);
        return true;
      },
      run: async (ctx) => {
        if (filter.ok === false) return;
        if (opts.count === 0) { footer(ctx); return; }
        await new Promise<void>((resolve) => {
          const finish = () => { unsubscribe?.(); unsubscribe = null; resolve(); };
          if (ctx.cancelled()) { resolve(); return; }
          unsubscribe = dev.openTcpdumpCapture(opts.iface, (frame) => {
            if (filter.ok && !filter.predicate(frame)) return;
            ctx.sink.line(formatCaptureFrame(frame, opts, prev));
            prev = frame.at;
            captured++;
            if (opts.count !== null && captured >= opts.count) finish();
          });
          ctx.onCancel(finish);
        });
        if (!ctx.cancelled()) footer(ctx);
      },
      onInterrupt: (ctx) => footer(ctx),
    });
    return job !== null;
  }

  private tryStartJournalFollow(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'journalctl') return false;
    if (!toks.includes('-f') && !toks.includes('--follow')) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const shell = this.shell;

    const uIdx = Math.max(toks.indexOf('-u'), toks.indexOf('--unit'));
    const unit = uIdx >= 0 ? toks[uIdx + 1] : undefined;
    const nIdx = Math.max(toks.indexOf('-n'), toks.indexOf('--lines'));
    const initialArgs = toks.slice(1).filter((t) => t !== '-f' && t !== '--follow');
    if (nIdx < 0) { initialArgs.unshift('10'); initialArgs.unshift('-n'); }
    const initialCommand = ['journalctl', ...initialArgs].join(' ');

    return this.startFollowStream({
      commandLine,
      prepare: (ctx) => {
        const initial = dev.runCommandFrameInSession(initialCommand, shell);
        if (initial.startsWith('No journal files')) { ctx.sink.line(initial); return false; }
        for (const line of initial.split('\n')) ctx.sink.line(line);
        return true;
      },
      subscribe: (sink) => dev.followJournal({ unit }, sink),
    });
  }

  private tryStartIpMonitor(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'ip') return false;
    let i = 1;
    while (i < toks.length && toks[i].startsWith('-')) i++;
    if (toks[i] !== 'monitor') return false;

    const spec = parseIpMonitorSpec(toks.slice(i + 1));
    if ('error' in spec) { this.addLine(spec.error); return true; }

    return this.startFollowStream({
      commandLine,
      kind: 'subscription',
      subscribe: (sink) => dev.monitorNetlink(
        { objects: spec.objects, labelled: spec.labelled },
        (block) => { for (const line of block.split('\n')) sink(line); },
      ),
    });
  }

  private tryStartDmesgFollow(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'dmesg') return false;
    if (!toks.includes('-w') && !toks.includes('--follow')) return false;
    const shell = this.shell;

    let raw = false;
    let humanTime = false;
    let levelFilter: string[] = [];
    for (let i = 1; i < toks.length; i++) {
      const a = toks[i];
      if (a === '-T' || a === '--ctime' || a === '-H' || a === '--human') humanTime = true;
      else if (a === '-r' || a === '--raw') raw = true;
      else if (a === '-l' || a === '--level') {
        levelFilter = (toks[++i] || '').split(',').map((l) => l.trim()).filter(Boolean);
      } else if (a.startsWith('--level=')) {
        levelFilter = a.slice(8).split(',').map((l) => l.trim()).filter(Boolean);
      }
    }

    const initialArgs = toks.slice(1).filter((t) => t !== '-w' && t !== '--follow');
    const initialCommand = ['dmesg', ...initialArgs].join(' ');

    return this.startFollowStream({
      commandLine,
      prepare: (ctx) => {
        const initial = dev.runCommandFrameInSession(initialCommand, shell);
        if (initial.startsWith('dmesg:') && !initial.includes('\n')) {
          ctx.sink.line(initial);
          return false;
        }
        if (initial) for (const line of initial.split('\n')) ctx.sink.line(line);
        return true;
      },
      subscribe: (sink) => dev.followDmesg({ raw, humanTime, levelFilter }, sink),
    });
  }

  private tryStartNetstatStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'netstat') return false;
    const continuous = toks.some(
      (t) => t.startsWith('-') && !t.startsWith('--') && t.includes('c'),
    ) || toks.includes('--continuous');
    if (!continuous) return false;
    const shell = this.shell;
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: 1000,
      frame: () => dev.runCommandFrameInSession(commandLine, shell),
    });
  }

  private async tryInteractiveRead(line: string): Promise<boolean> {
    if (!/^\s*read\b/.test(line)) return false;
    if (/[|<>]/.test(line)) return false;
    const parsed = parseReadInvocationLib(line.trim());
    if (!parsed) return false;
    if (!this.shell) return false;
    const broker = new PromiseInputBrokerLib(this.getInputHost());
    if (!broker.capabilities().interactive) return false;
    const ifs = this.shell.env.get('IFS') ?? ' \t\n';
    const outcome = await performInteractiveReadLib(broker, parsed, { ifs });
    if (!outcome.handled) return false;
    if (outcome.cancelled) {
      this.shell.lastExitCode = 130;
      return true;
    }
    for (const b of outcome.bindings ?? []) this.shell.env.set(b.name, b.value);
    this.shell.lastExitCode = 0;
    return true;
  }

  private async executeCommand(cmd: string): Promise<void> {
    const typed = cmd.trim();
    const trimmed = this.resolveActionLine(typed);

    this.addEchoLine(this.getPrompt(), cmd);

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
        : dev.handleExit?.() ?? { output: '', inSu: false };
      if (exitResult.inSu) {
        if (exitResult.output) this.addLine(exitResult.output);
        this.syncDeviceState();
        return;
      }
      if (this.sshStack.length > 0) {
        this.popRemoteDevice();
        return;
      }
      if (this.endRemoteSession()) return;
      // Signal close — the view/manager will handle it
      this._onRequestClose?.();
      return;
    }

    this.pushHistory(typed);

    // Intercept `tail -f` / `tail -F` — open a streaming follow on the
    // VFS through the unified async runtime; appended bytes flow into the
    // terminal until Ctrl+C cancels the foreground job.
    if (this.tryStartTailStream(trimmed)) return;
    if (this.tryStartPingStream(trimmed)) return;
    if (this.tryStartTracerouteStream(trimmed)) return;
    if (this.tryStartWatchStream(trimmed)) return;
    if (this.tryStartTopStream(trimmed)) return;
    if (this.tryStartJournalFollow(trimmed)) return;
    if (this.tryStartIpMonitor(trimmed)) return;
    if (this.tryStartDmesgFollow(trimmed)) return;
    if (this.tryStartNetstatStream(trimmed)) return;
    if (this.tryStartTcpdump(trimmed)) return;
    if (this.tryCrontabEdit(trimmed)) return;
    if (await this.tryInteractiveRead(trimmed)) return;

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

    // Intercept Oracle CLI tools (only if no sudo prefix). sqlplus and
    // rman now flow through LinuxBashShell's SUBSHELL_TRIGGERS — bash
    // creates the IShell-backed adapter via ShellFactory, the session
    // pushes the child via pushIShellAsSubShell. We keep the legacy
    // helpers below for tools the bash layer does not intercept yet.
    if (!trimmed.startsWith('sudo ')) {
      const noSudo = trimmed;
      const parts = noSudo.split(/\s+/);
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

    // Delegate plain-command execution to the local LinuxBashShell so
    // ANSI parsing, history hand-off and styled output go through the
    // same pipeline as SSH-pushed bash. The shell shares this session's
    // LinuxShellSession (preexistingSession) so cwd/env/suStack stay in
    // sync with the legacy paths that still mutate state directly.
    try {
      const shell = this.ensureRootBash();
      if (shell) {
        const result = await shell.processLine(trimmed);
        // Shell explicitly asked for a clear (clear / cls / reset), OR
        // ANSI clear-screen sequence — wipe scrollback like a real tty.
        const joined = result.output.join('\n');
        if (result.clearScreen
            || joined.includes('\x1b[2J')
            || joined.includes('\x1b[H')) {
          this.clear();
        } else if (result.styledOutput && result.styledOutput.length > 0) {
          for (const styled of result.styledOutput) {
            this.addStyledLine(styled.segments, styled.lineType);
          }
        } else {
          for (const line of result.output) this.addLine(line);
        }
        if (result.childShell) {
          // Bash recognised a sub-shell launcher (sqlplus, rman, ssh, …)
          // and produced a child IShell. The session pushes it through
          // its sub-shell stack so existing handleSubShellKey / pop
          // mechanics keep working unchanged.
          this.pushIShellAsSubShell(result.childShell);
        }
        if (result.pendingInput) {
          // The shell asks the host terminal for a password / text
          // value. Linux uses its own pendingSshPush flow for top-level
          // ssh; for shell-emitted pendingInput we mirror the Windows
          // contract: set inputMode and route the next Enter to
          // shell.handleInput via feedRootBashInput.
          this.rootBashPendingInput = result.pendingInput;
          this.inputMode = result.pendingInput.kind === 'password'
            ? { type: 'password', promptText: result.pendingInput.promptText }
            : { type: 'interactive-text', promptText: result.pendingInput.promptText };
        }
        if (result.exit) {
          this._onRequestClose?.();
        }
      } else {
        // Fall back to the legacy direct call for synthetic test doubles
        // that are not real LinuxMachines.
        const raw = await this.executeOnDevice(trimmed);
        if (raw) {
          if (raw.includes('\x1b[2J') || raw.includes('\x1b[H')) this.clear();
          else this.addLine(raw);
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

  private _pendingCrontabEdit: { user: string; tmpPath: string } | null = null;

  private tryCrontabEdit(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    let toks = commandLine.trim().split(/\s+/);
    if (toks[0] === 'sudo') toks = toks.slice(1);
    if (toks[0] !== 'crontab' || !toks.includes('-e')) return false;

    const current = dev.getCurrentUser();
    const uIdx = toks.indexOf('-u');
    const user = uIdx >= 0 ? (toks[uIdx + 1] ?? current) : current;
    if (user !== current && current !== 'root') {
      this.addLine('crontab: must be privileged to use -u');
      return true;
    }

    const template = dev.crontabEditTemplate(user);
    const tmpPath = `/tmp/crontab.${Math.floor(Math.random() * 1e6)}`;
    dev.writeFileFromEditorInSession(tmpPath, template, this.shell);
    this._pendingCrontabEdit = { user, tmpPath };
    this.openEditor('nano', [tmpPath]);
    return true;
  }

  private finishCrontabEdit(saved: boolean): void {
    const pending = this._pendingCrontabEdit;
    this._pendingCrontabEdit = null;
    this.inputMode = { type: 'normal' };
    const dev = this.device;
    if (saved && dev instanceof LinuxMachine && this.shell) {
      const content = dev.readFileForEditorInSession(pending!.tmpPath, this.shell) ?? '';
      dev.installCrontabContent(content, pending!.user);
      this.addLine('crontab: installing new crontab');
    } else {
      this.addLine('no changes made to crontab');
    }
    this.notify();
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
      : this.device.resolveAbsolutePath?.(filePath) ?? filePath;
    const existingContent = (this.shell && dev instanceof LinuxMachine)
      ? dev.readFileForEditorInSession(absolutePath, this.shell)
      : this.device.readFileForEditor?.(absolutePath) ?? null;
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
      this.device.writeFileFromEditor?.(filePath, content);
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
    if (this._pendingCrontabEdit) { this.finishCrontabEdit(saved); return; }
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
      this.notify();
      return;
    }
    // SSH-pushed onto a non-Linux device (no LinuxShellSession on the
    // remote). The SSH user we authenticated as is the authoritative
    // identity for the duration of the push; reading the device's
    // local-console user would drift back to e.g. 'user' on a Windows
    // host and break the prompt mid-session.
    if (this.sshStack.length > 0) {
      const cwd = this.device.getCwd?.();
      if (cwd) this.currentPath = cwd;
      this.notify();
      return;
    }
    const cwd = this.device.getCwd?.();
    if (cwd) this.currentPath = cwd;
    this.currentUser = this.device.getCurrentUser?.() ?? 'user';
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
  private resolveActionLine(command: string): string {
    const aliases = (this.device as unknown as { executor?: { aliases?: { get: (n: string) => { tokens(): string[] } | undefined } } }).executor?.aliases;
    if (!aliases) return command;
    const trimmed = command.replace(/^\s+/, '');
    const m = /^(\S+)(\s[\s\S]*)?$/.exec(trimmed);
    if (!m) return command;
    let head = m[1];
    let rest = m[2] ?? '';
    const seen = new Set<string>();
    while (!seen.has(head)) {
      seen.add(head);
      const alias = aliases.get(head);
      if (!alias) break;
      const tokens = alias.tokens();
      if (tokens.length === 0) break;
      head = tokens[0];
      const tail = tokens.slice(1).join(' ');
      rest = (tail ? ' ' + tail : '') + rest;
    }
    return head + rest;
  }

  private startInteractiveFlow(command: string): boolean {
    // Use the per-terminal shell session's identity, not the device-wide
    // executor's: `su`/`sudo -s` push a frame onto *this* terminal's shell
    // (see executeOnDevice), so after `su root` the device-level user is
    // still stale. Reading it here would mis-classify a root terminal as
    // non-root and skip the `adduser` / `passwd` interactive flows.
    const currentUser = this.shell ? this.shell.user : this.device.getCurrentUser?.() ?? 'user';
    const currentUid = this.shell ? this.shell.uid : this.device.getCurrentUid?.() ?? 0;

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
    const xvendor = ctx.metadata.get('xvendor_push') as string | undefined;
    if (xvendor && this.crossVendorPushTarget) {
      const { host, user } = JSON.parse(xvendor) as { host: string; user: string };
      const target = this.crossVendorPushTarget;
      this.crossVendorPushTarget = null;
      this.pushRemoteDeviceWithStrategy(target.device, user, host, target.strategy);
      return;
    }
    this.crossVendorPushTarget = null;
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
      installDefaultShells();
      const shell = ShellFactory.create('sqlplus', {
        device: this.device,
        user: this.currentUser,
        launchLine: `sqlplus ${args.join(' ')}`.trim(),
      }) as SqlPlusShell;
      if (!shell.isReady) {
        this.addLine('bash: sqlplus: command not found', 'error');
        this.notify();
        return;
      }
      this.activeSubShell = new ShellSubShellAdapter(shell);
      for (const line of shell.getActivationBanner()) this.addLine(line);
      this.addLine('');
      shell.activate();
      this._inputBuf = '';
      this.notify();
    } catch (err) {
      this.addLine(`bash: sqlplus: ${err instanceof Error ? err.message : String(err)}`, 'error');
      this.notify();
    }
  }

  private enterRman(args: string[]): void {
    try {
      installDefaultShells();
      const shell = ShellFactory.create('rman', {
        device: this.device,
        user: this.currentUser,
        launchLine: `rman ${args.join(' ')}`.trim(),
      }) as RmanShell;
      if (!shell.isReady) {
        this.addLine('bash: rman: command not found', 'error');
        this.notify();
        return;
      }
      this.activeSubShell = new ShellSubShellAdapter(shell);
      for (const line of shell.getActivationBanner()) this.addLine(line);
      shell.activate();
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

    installDefaultShells();
    const shell = ShellFactory.create('sftp', {
      device: this.device,
      user: this.currentUser,
      extras: { sftpSession: session },
    });
    this.activeSubShell = new ShellSubShellAdapter(shell);
    shell.activate();
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
      this.addEchoLine(shell.getPrompt(), cmd);
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
    if (!merged.command) {
      const handled = await this.tryEnterCrossVendorSsh(merged);
      if (handled) return;
    }
    await this.connectAndEnterSsh(merged);
  }

  /**
   * Cross-vendor SSH push (BRD SSH-04 extended): when the target IP belongs
   * to a non-Linux device that exposes a {@link CrossVendorSshHost}, bypass
   * the TCP/SshSession machinery (no TCP listener on routers / Windows in
   * the simulator) and validate the password directly against the host's
   * auth gate. On accept, push a {@link RemoteDeviceSubShell} configured
   * with the vendor's prompt strategy so the user genuinely lands in
   * `Router#`, `<HW>` or `C:\Users\…>`.
   */
  private async tryEnterCrossVendorSsh(
    meta: { userAtHost: string; port: number },
  ): Promise<boolean> {
    const user = meta.userAtHost.includes('@')
      ? meta.userAtHost.split('@')[0]
      : this.currentUser;
    const host = meta.userAtHost.includes('@')
      ? meta.userAtHost.split('@')[1]
      : meta.userAtHost;
    const target = findEquipmentByIp(host);
    if (!target || target instanceof LinuxMachine) return false;
    const sshHost = (target as unknown as { getSshHost?: () => unknown }).getSshHost?.() as
      | { evaluate: (req: SshConnectionRequest) => { outcome: string } }
      | undefined;
    if (!sshHost) return false;

    const strategy = pickVendorPromptStrategy(target);
    if (!strategy) return false;

    const steps: InteractiveStep[] = [
      {
        type: 'password',
        prompt: `${user}@${host}'s password:`,
        storeAs: 'ssh_password',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          const password = ctx.values.get('ssh_password') ?? '';
          const request = SshConnectionRequest.create({
            requestedUser: user,
            requestedHost: host,
            requestedPort: meta.port,
            sourceIp: this.lookupSourceIp(),
            sourceHostname: this.device.getHostname() || '',
            command: null,
            offeredAuthMethods: ['password'],
            credentials: { password },
          });
          const decision = sshHost.evaluate(request);
          if (decision.outcome !== 'accepted') {
            this.addLine(`${user}@${host}: Permission denied (publickey,password).`, 'error');
            return;
          }
          ctx.metadata.set('xvendor_push', JSON.stringify({ host, user }));
        },
      },
    ];

    this.crossVendorPushTarget = { device: target, strategy };
    this.startFlowFromSteps(steps, `ssh ${user}@${host}`);
    return true;
  }

  private crossVendorPushTarget: { device: Equipment; strategy: RemotePromptStrategy } | null = null;

  private lookupSourceIp(): string {
    const portsObj = (this.device as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
    if (portsObj) {
      for (const p of portsObj.values()) {
        const ip = p.getIPAddress?.();
        if (ip) return ip.toString();
      }
    }
    return '0.0.0.0';
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
    const linuxRemoteDevice = findLinuxMachineByIp(host);
    const remoteForwarders = linuxRemoteDevice
      ? this.installRemoteForwards(session, host, linuxRemoteDevice, meta)
      : [];
    const agentForwarding = linuxRemoteDevice
      ? this.installAgentForwarding(linuxRemoteDevice, meta)
      : null;
    const onSessionEnd = () => {
      for (const f of forwarders) f.dispose();
      for (const f of dynamicForwarders) f.dispose();
      for (const f of remoteForwarders) f.dispose();
      agentForwarding?.detach();
      session.disconnect();
    };

    const anyRemoteDevice = linuxRemoteDevice ?? findEquipmentByIp(host);
    if (anyRemoteDevice) {
      // Non-Linux peers (Windows / Cisco / Huawei) need their vendor
      // shell on the stack — otherwise the terminal renders the bash
      // prompt for a Windows cwd and routes commands to the bare
      // device.executeCommand, so `powershell` / mode-switches never
      // engage. Linux peers keep the generic push (no foreign shell).
      const vendorStrategy = anyRemoteDevice instanceof LinuxMachine
        ? null
        : pickVendorPromptStrategy(anyRemoteDevice);
      if (vendorStrategy) {
        this.pushRemoteDeviceWithStrategy(
          anyRemoteDevice, user, host, vendorStrategy, onSessionEnd,
        );
      } else {
        this.pushRemoteDevice(anyRemoteDevice, user, host, onSessionEnd);
      }
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
      this.addEchoLine(this.activeSubShell.getPrompt(), line);

      // Push non-empty lines to sub-shell history
      if (line.trim()) {
        this.subShellHistory = [...this.subShellHistory.slice(-199), line];
      }

      const maybePromise = this.activeSubShell.processLine(line);

      const applyResult = (result: import('@/terminal/subshells/ISubShell').SubShellResult & { childShell?: import('@/shell').IShell }) => {
        if (result.clearScreen) this.clear();

        if (result.styledOutput && result.styledOutput.length > 0) {
          for (const styled of result.styledOutput) this.addStyledLine(styled.segments, styled.lineType);
        } else {
          for (const outputLine of result.output) this.addLine(outputLine);
        }

        if (result.exit) {
          this.exitSubShell();
          return;
        }
        // Sub-shell launched a deeper child (sqlplus → spooled, nested
        // ssh, …). Push it through the same IShell stacking mechanic so
        // the OuterRemoteShell / OuterCmd / OuterPS sees no difference.
        if (result.childShell) {
          this.pushIShellAsSubShell(result.childShell);
          return;
        }
        // Sub-shell asked the host for a password / text value. Mirror
        // the Windows contract: set inputMode, then route Enter back
        // through shell.handleInput via feedSubShellInput.
        if (result.pendingInput) {
          this.subShellPendingInput = result.pendingInput;
          this.inputMode = result.pendingInput.kind === 'password'
            ? { type: 'password', promptText: result.pendingInput.promptText }
            : { type: 'interactive-text', promptText: result.pendingInput.promptText };
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
      // Consult the inner shell — only POSIX-style shells (bash, sftp,
      // sqlplus, …) honour Ctrl+D as EOF. cmd.exe and PowerShell do not.
      // The ShellSubShellAdapter forwards to its IShell's classifyKey and
      // returns true iff the action is `eof`. We pop only then.
      const isEof = !!(this.activeSubShell as { handleKey?: (e: KeyEvent) => boolean })
        .handleKey?.(e);
      if (isEof) this.exitSubShell();
      return true;
    }

    // Let the view handle other keys (typing into the interactive-text input)
    return false;
  }

  private exitSubShell(): void {
    const wasSshAdapter = this.activeSubShell instanceof ShellSubShellAdapter
      && this.activeSubShell.inner.kind === 'ssh-remote';
    if (this.activeSubShell) {
      this.activeSubShell.dispose();
      this.activeSubShell = null;
    }
    this._inputBuf = '';
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    this.subShellSavedInput = '';
    this.inputMode = { type: 'normal' };
    if (wasSshAdapter && this.sshStack.length > 0) {
      this.popRemoteDevice();
      return;
    }
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
    remote: HostCapableDevice,
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
    this.currentPath = remoteShell?.cwd ?? remote.getCwd?.() ?? `/home/${user}`;
    this.notify();
  }

  pushRemoteDeviceWithStrategy(
    remote: Equipment,
    user: string,
    label: string,
    strategy: RemotePromptStrategy,
    onPop: () => void = () => undefined,
  ): void {
    const pausedShell = this.shell;
    this.sshStack.push({
      device: this.device,
      user: this.currentUser,
      path: this.currentPath,
      pausedShell,
      onPop: () => { try { onPop(); } catch { /* swallow */ } },
      label,
    });
    this.device = remote;
    this.shell = null;
    this.currentUser = user;
    this.currentPath = `~`;

    installDefaultShells();
    const primaryKind = pickPrimaryKindFromStrategy(strategy);
    if (primaryKind && ShellFactory.has(primaryKind)) {
      const xshell = new CrossVendorRemoteShell({
        device: remote, user, remoteHost: label, primaryKind,
      });
      this.activeSubShell = new ShellSubShellAdapter(xshell);
    } else {
      this.activeSubShell = new RemoteDeviceSubShell(remote, user, label, strategy);
    }
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
    if (typeof (localDevice as { getTcpStack?: unknown }).getTcpStack !== 'function') {
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
    if (typeof (localDevice as { getTcpStack?: unknown }).getTcpStack !== 'function') {
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
    if (typeof (remoteDevice as { getTcpStack?: unknown }).getTcpStack !== 'function') {
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
function pickPrimaryKindFromStrategy(s: RemotePromptStrategy): string | null {
  if (s === CiscoStrategyRef) return 'cisco-ios';
  if (s === HuaweiStrategyRef) return 'huawei-vrp';
  if (s === WindowsStrategyRef) return 'cmd';
  if (s === LinuxStrategyRef) return 'bash';
  return null;
}

function pickVendorPromptStrategy(eq: Equipment): RemotePromptStrategy | null {
  const kind = primaryShellKindFor(eq);
  return kind === 'bash' ? null : strategyForShellKind(kind);
}

function findEquipmentByIp(targetIp: string): Equipment | null {
  const all = (Equipment as unknown as { getAllEquipment: () => Equipment[] })
    .getAllEquipment();
  for (const eq of all) {
    const portsObj = (eq as unknown as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
    if (!portsObj) continue;
    for (const port of portsObj.values()) {
      const ip = port.getIPAddress?.();
      if (ip && ip.toString() === targetIp) {
        if (typeof (eq as unknown as { executeCommand?: unknown }).executeCommand === 'function') {
          return eq;
        }
      }
    }
  }
  return null;
}

function findLinuxMachineByIp(targetIp: string): Equipment | null {
  const eq = findEquipmentByIp(targetIp);
  if (eq && eq instanceof LinuxMachine) return eq;
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

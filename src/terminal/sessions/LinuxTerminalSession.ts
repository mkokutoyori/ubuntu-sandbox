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
import { IPAddress } from '@/network/core/types';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { parseDialAddress, type DialAddress } from '@/network/tcp/dial';
import { HostsFile } from '@/network/devices/HostsFile';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { parsePingArgs } from '@/network/devices/linux/commands/net/Ping';
import { parseTracerouteArgs } from '@/network/devices/linux/commands/net/Traceroute';
import { parseMtrArgs, MtrHopStats, formatMtrFrame, MTR_USAGE, MTR_VERSION, type MtrHopProbe } from '@/network/devices/linux/Mtr';
import { parseWatchArgs } from '@/network/devices/linux/coreutils/WatchRunner';
import { parseIpMonitorSpec } from '@/network/devices/linux/LinuxIpCommand';
import { parseVmstatArgs, vmstatHeader, formatVmstatRow } from '@/network/devices/linux/system/Vmstat';
import {
  parseMpstatArgs,
  mpstatColumnHeader,
  formatMpstatRow,
  formatMpstatAverageRow,
  MpstatAccumulator,
} from '@/network/devices/linux/system/Mpstat';
import {
  parsePidstatArgs,
  pidstatColumnHeader,
  formatPidstatCpuRow,
  formatPidstatMemRow,
  formatPidstatAverageCpuRow,
  formatPidstatAverageMemRow,
  PidstatAccumulator,
  type PidstatCpuRow,
  type PidstatMemRow,
} from '@/network/devices/linux/system/Pidstat';
import { parseIostatArgs, renderIostatReport } from '@/network/devices/linux/system/Iostat';
import {
  parseDstatArgs, formatDstatHeader, formatDstatRow, newDstatRateState,
  DSTAT_USAGE, DSTAT_VERSION, DSTAT_LISTING,
} from '@/network/devices/linux/system/Dstat';
import { parseInvocation } from '@/network/devices/linux/network/tcpdump/TcpdumpCli';
import { compileFilter } from '@/network/devices/linux/network/tcpdump/TcpdumpFilter';
import { banner as tcpdumpBanner, footer as tcpdumpFooterLines, formatFrame as formatCaptureFrame } from '@/network/devices/linux/network/tcpdump/TcpdumpFormat';
import { formatPingHeader, formatPing6Header, formatPingReplyLine, formatPingStats, formatTracerouteHeader, formatTracerouteHopLine } from '@/network/devices/linux/LinuxFormatHelpers';
import type { PingResult } from '@/network/devices/EndHost';
import type { AsyncJobContext } from '@/terminal/async';
import { primaryShellKindFor } from '@/shell/shellKind';
import {
  TerminalSession, TerminalTheme, SessionType,
  KeyEvent, InputMode, withTimeout, DeviceOfflineError,
} from './TerminalSession';
import { createSessionForDevice } from './sessionFactory';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import { validateSudoersContent } from '@/network/devices/linux/iam/PwGrCheck';
import { validateCrontabContent } from '@/network/devices/linux/cron/CrontabParser';
import type { LinuxShellSession } from '@/network/devices/linux/shell/LinuxShellSession';
import { AnsiOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { CompletionController, ReadlinePolicy, CyclingPolicy, LastWordSource, ghostRemainder } from '@/terminal/completion';
import { toInteractiveSteps } from '@/terminal/flows/planAdapter';
import { analyzeBashInput } from '@/bash/incompleteInput';
import {
  parseReadInvocation as parseReadInvocationLib,
  performInteractiveRead as performInteractiveReadLib,
  PromiseInputBroker as PromiseInputBrokerLib,
} from '@/shell/input';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman/ReactiveRmanSubShell';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import { NsupdateSubShell } from '@/terminal/subshells/NsupdateSubShell';
import { nsupdateNamesAFile } from '@/network/dns/update/NsupdateScript';
import { parseNsupdateKeyOption } from '@/network/dns/update/NsupdateScript';
import type { TsigKey } from '@/network/dns/tsig/Tsig';
import { FtpSubShell } from '@/terminal/subshells/FtpSubShell';
import { FtpClientSession } from '@/network/ftp/FtpClientSession';
import { NslookupSubShell } from '@/terminal/subshells/NslookupSubShell';
import { readResolverIP } from '@/network/devices/linux/commands/dns/resolverIP';
import { RemoteShellSubShell } from '@/terminal/subshells/RemoteShellSubShell';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import { launchTelnet } from '@/terminal/subshells/telnetLaunch';
import { establishedSessionLiveness, peerLiveness } from '@/network/protocols/ssh/sessionLiveness';
import type { EditorView } from '@/network/devices/linux/editors/EditorView';
import { parseEditorLaunch, isEditorSegment } from '@/network/devices/linux/editors/editorLaunch';
import {
  createRemoteEditorController,
  type RemoteEditorTransport,
} from '@/terminal/editors/RemoteEditorController';
import { installDefaultShells } from '@/shell/registerDefaults';
import { ShellFactory } from '@/shell/ShellFactory';
import { ShellSubShellAdapter } from '@/shell/ShellSubShellAdapter';
import { LinuxBashShell } from '@/shell/adapters/LinuxBashShell';
import { ShellContext } from '@/shell/ShellContext';
import { SqlPlusShell } from '@/shell/adapters/SqlPlusShell';
import { RmanShell } from '@/shell/adapters/RmanShell';
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
import type { TcpConnector } from '@/network/tcp/types';
import type { ISubShell } from '@/terminal/subshells/ISubShell';
import { handleLsnrctl, handleTnsping, handleDbca, handleOrapwd, handleAdrci, handleExpdp, handleImpdp } from '@/terminal/commands/OracleCommands';
import type { FlowContext, InteractiveStep } from '@/terminal/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

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
  private readonly rootCompletion =
    new CompletionController(new ReadlinePolicy({ caseInsensitive: false }));
  private readonly subShellCompletion = new CompletionController(new CyclingPolicy());
  /** Active sub-shell (SQL*Plus, or any future REPL). Null when in normal bash mode. */
  private activeSubShell: ISubShell | null = null;

  /**
   * Accumulated physical lines of a not-yet-complete command (open quote,
   * trailing `\`, dangling connector, open block, or here-document). Null
   * when no continuation is in progress. Drives the PS2 `>` prompt.
   */
  private _continuationBuffer: string | null = null;
  /**
   * The delimiter the accumulation is waiting for, when the reason for the
   * continuation is a here-document specifically. Null for every other
   * reason. Ctrl+D and Tab behave differently inside a here-document body
   * than inside an open quote or block, and this is what tells them apart.
   */
  private _pendingHeredocDelimiter: string | null = null;
  /** Line number the current here-document body started on, for the EOF warning. */
  private _heredocStartLine = 0;
  /** PS2 continuation prompt — real bash default. */
  private readonly ps2Prompt = '> ';

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
    // PS2 continuation prompt while accumulating an incomplete command
    // (open quote, trailing `\`, dangling connector, open block, heredoc).
    if (this._continuationBuffer !== null) return this.ps2Prompt;
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
    // PS2 has no user@host:path shape to decompose. Marking it foreign is
    // what makes the renderer print `getPrompt()` verbatim — without this
    // the canvas terminal kept showing PS1 through a whole here-document,
    // even though the session was collecting a body.
    if (this._continuationBuffer !== null && !this.hasActiveChild && !this.activeSubShell) {
      return {
        user: this.currentUser,
        hostname: this.device.getHostname() || 'localhost',
        path: this.currentPath,
        promptChar: '$',
        foreign: true,
      };
    }
    if (this.hasActiveChild) {
      if (this.foreground.getSessionType() !== 'linux') {
        return {
          user: this.currentUser,
          hostname: this.device.getHostname() || 'localhost',
          path: this.currentPath,
          promptChar: '$',
          foreign: true,
        };
      }
      // The foreground child is itself a Linux session (SSH'd into
      // another Linux box) — its own currentUser/device/currentPath are
      // the ones that must render, not this (parent) session's. Delegate
      // recursively so multi-hop Linux→Linux→Linux chains each show
      // their own remote hostname in turn.
      return (this.foreground as LinuxTerminalSession).getPromptParts();
    }
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
    // An editor opened on the remote owns the screen the same way a
    // local one does — the SSH sub-shell underneath is suspended until
    // the engine exits (docs/PRD-SSH-Unification.md §4bis B3).
    if (this.inputMode.type === 'remote-editor') {
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
    if (this.inputMode.type === 'editor' || this.inputMode.type === 'remote-editor') return false;

    if (e.key === 'd' && e.ctrlKey && this.input === '') {
      // Ctrl+D inside an open here-document ends the document, it does not
      // end the shell: bash warns and runs the command with the body it
      // has. Nothing here may close the session or the SSH connection.
      if (this._pendingHeredocDelimiter !== null) { void this.endHeredocAtEof(); return true; }
      if (this.endRemoteSession()) return true;
      if (this.sshStack.length > 0) { this.popRemoteDevice(); return true; }
      this._onRequestClose?.();
      return true;
    }

    return super.handleKey(e);
  }

  protected override pendingHeredocDelimiter(): string | null {
    return this._pendingHeredocDelimiter;
  }

  /**
   * Ctrl+C at a PS2 prompt abandons the whole accumulated command, whatever
   * kept it open — an open quote, a block, or a here-document body. Without
   * this the buffer survived the interrupt and the next line typed was
   * silently appended to a command the user believed cancelled.
   */
  protected override onCtrlC(): void {
    // Cleared before the base class echoes `^C`, so the line it prints
    // carries PS1 rather than the PS2 being abandoned.
    this._continuationBuffer = null;
    this._pendingHeredocDelimiter = null;
    super.onCtrlC();
  }

  /**
   * `bash: warning: here-document at line N delimited by end-of-file
   * (wanted 'DELIM')` — then the command runs with the partial body. The
   * lexer already accepts a here-document left open at EOF, so the text is
   * handed over exactly as accumulated, with no delimiter line.
   */
  private endHeredocAtEof(): void | Promise<void> {
    const accumulated = this._continuationBuffer ?? '';
    const delimiter = this._pendingHeredocDelimiter;
    this._continuationBuffer = null;
    this._pendingHeredocDelimiter = null;
    this.addLine(this.getPrompt());
    this.addLine(
      `bash: warning: here-document at line ${this._heredocStartLine} `
      + `delimited by end-of-file (wanted \`${delimiter}')`,
    );
    const done = this.executeCommand(accumulated, { echo: false });
    this.notify();
    return done;
  }

  /**
   * Key handler used while a reactive SSH IO prompt is active.
   * Submits input on Enter, cancels on Ctrl+C, suppresses history navigation.
   */
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
      // A here-document body is free text, not a command line: readline
      // does not complete there, it just takes the tab. `<<-` even relies
      // on leading tabs being typeable.
      if (this._pendingHeredocDelimiter !== null) {
        this.setInput(this.input + '\t');
        return true;
      }
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

  protected onEnter(): void | Promise<void> {
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

    // Interactive line continuation (PS2): only on the local root bash,
    // never inside a sub-shell / SSH device shell / active flow. Accumulate
    // physical lines until the command is lexically complete, echoing each
    // at the current prompt exactly like real bash.
    if (!this.activeSubShell && !this.isFlowActive) {
      const accumulated = this._continuationBuffer !== null
        ? `${this._continuationBuffer}\n${cmd}`
        : cmd;
      const analysis = analyzeBashInput(accumulated);
      if (!analysis.complete) {
        this.addEchoLine(this.getPrompt(), cmd);
        if (this._continuationBuffer === null && analysis.heredocDelimiter) {
          this._heredocStartLine = accumulated.split('\n').length;
        }
        this._continuationBuffer = accumulated;
        this._pendingHeredocDelimiter = analysis.heredocDelimiter ?? null;
        this.notify();
        return;
      }
      if (this._continuationBuffer !== null) {
        // Final line of a multi-line command: echo it, then run the whole
        // accumulated text without re-echoing (executeCommand echoes the
        // first line; the continuation lines were already echoed live).
        this.addEchoLine(this.getPrompt(), cmd);
        this._continuationBuffer = null;
        this._pendingHeredocDelimiter = null;
        const doneMulti = this.executeCommand(accumulated, { echo: false });
        this.notify();
        return doneMulti;
      }
    }

    // The 'input' record event is emitted by addEchoLine inside
    // executeCommand — recording here too would duplicate every typed
    // command in the session transcript.
    const done = this.executeCommand(cmd);
    this.notify();
    return done;
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
    if (!parsed.targetStr) return false;

    // Real Linux ping has no Windows-style "-t" — it's continuous by
    // default and only stops on `-c`, `-w`, or Ctrl+C. `parsePingArgs`
    // defaults `count` to a finite number for the non-interactive
    // `runPing()` path (which can't support a real Ctrl+C), but here — the
    // real interactive terminal — an omitted `-c` means unbounded. Applies
    // to `ping -6` too, not just IPv4.
    const streamCount = parsed.countGiven ? parsed.count : 0;
    const deadlineAtMs = parsed.deadlineMs !== undefined ? Date.now() + parsed.deadlineMs : null;
    const deadlineHit = () => deadlineAtMs !== null && Date.now() >= deadlineAtMs;

    let targetLabel = parsed.targetStr;
    const results: PingResult[] = [];
    // Real ping reports the wall time of the whole run in its summary.
    const pingStartedAt = Date.now();
    const emitStats = (ctx: AsyncJobContext) => {
      for (const line of formatPingStats(targetLabel, results.length, results, Date.now() - pingStartedAt)) ctx.sink.line(line);
    };

    if (parsed.v6) {
      const job = this.startAsyncCommand({
        mode: 'foreground',
        kind: 'streaming',
        command: commandLine,
        run: async (ctx) => {
          const outcome = await dev.ping6StreamInSession(parsed.targetStr, {
            count: streamCount,
            timeoutMs: parsed.timeoutMs,
            intervalMs: parsed.intervalMs,
            onResolved: (ip) => { targetLabel = ip.toString(); ctx.sink.line(formatPing6Header(ip, parsed.size, parsed.targetStr !== ip.toString() ? parsed.targetStr : undefined)); },
            onResult: (r) => { results.push(r); const line = formatPingReplyLine(r, parsed.size); if (line !== null) ctx.sink.line(line); },
            shouldStop: () => ctx.cancelled() || deadlineHit(),
            sleep: (ms) => ctx.delay(ms),
          });
          if (ctx.cancelled()) return;
          if (!outcome.resolved && results.length === 0) {
            ctx.sink.error(outcome.reason === 'name'
              ? `ping6: ${parsed.targetStr}: Name or service not known`
              : 'connect: Network is unreachable');
            return;
          }
          emitStats(ctx);
        },
        onInterrupt: (ctx) => emitStats(ctx),
      });
      return job !== null;
    }

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        const outcome = await dev.pingStreamInSession(parsed.targetStr, {
          count: streamCount,
          timeoutMs: parsed.timeoutMs,
          ttl: parsed.ttl,
          intervalMs: parsed.intervalMs,
          onResolved: (ip) => { targetLabel = ip.toString(); ctx.sink.line(formatPingHeader(ip, parsed.size, parsed.targetStr !== ip.toString() ? parsed.targetStr : undefined)); },
          onResult: (r) => { results.push(r); const line = formatPingReplyLine(r, parsed.size); if (line !== null) ctx.sink.line(line); },
          shouldStop: () => ctx.cancelled() || deadlineHit(),
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

  private tryStartMtrStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'mtr') return false;
    if (/[|<>&]/.test(commandLine)) return false;

    const parsed = parseMtrArgs(toks.slice(1));
    if (parsed.showHelp) { this.addLine(MTR_USAGE); this.notify(); return true; }
    if (parsed.showVersion) { this.addLine(MTR_VERSION); this.notify(); return true; }
    if (parsed.parseError) { this.addLine(parsed.parseError); this.notify(); return true; }
    if (!parsed.target) { this.addLine('mtr: no host specified'); this.notify(); return true; }

    const intervalMs = Math.max(100, parsed.intervalSec * 1000);
    let baseLen = this.lines.length;

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      prepare: () => { baseLen = this.lines.length; return true; },
      run: async (ctx) => {
        const hopIps: (string | null)[] = [];
        let resolved = false;
        const discovery = await dev.tracerouteStreamInSession(parsed.target, {
          maxHops: parsed.maxHops,
          probesPerHop: 1,
          onResolved: () => { resolved = true; },
          onHop: (hop) => { hopIps.push(hop.ip ?? null); },
          shouldStop: () => ctx.cancelled(),
        });
        if (ctx.cancelled()) return;
        if (!discovery.resolved) {
          ctx.sink.error(`mtr: Failed to resolve host: ${parsed.target}`);
          return;
        }
        if (!resolved || hopIps.length === 0) {
          ctx.sink.error('mtr: no hops discovered');
          return;
        }

        const stats = hopIps.map(() => new MtrHopStats());
        const startedAt = new Date();
        const hostname = dev.getHostname();
        const targetIpStr = hopIps[hopIps.length - 1] ?? parsed.target;

        const paint = () => {
          this.lines = this.lines.slice(0, baseLen);
          const frame = formatMtrFrame({ hostname, target: targetIpStr, startedAt, hops: stats },
            parsed.reportMode ? 'report' : 'live');
          for (const line of frame.split('\n')) this.addLine(line);
          this.notify();
        };
        paint();

        for (let cycle = 0; ; cycle++) {
          if (ctx.cancelled()) return;
          if (parsed.reportMode && cycle >= parsed.cycles) break;
          for (let i = 0; i < hopIps.length; i++) {
            const ip = hopIps[i];
            let probe: MtrHopProbe;
            if (!ip) {
              probe = { lost: true };
            } else {
              try {
                const result = dev.sendPingProbeSync(new IPAddress(ip));
                probe = result.success
                  ? { ip, rttMs: result.rttMs, lost: false }
                  : { ip, lost: true };
              } catch {
                probe = { ip, lost: true };
              }
            }
            stats[i].record(probe);
          }
          paint();
          if (parsed.reportMode && cycle + 1 >= parsed.cycles) break;
          await ctx.delay(intervalMs);
        }
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

  private tryStartFreeStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'free') return false;
    let intervalSeconds: number | null = null;
    let count: number | null = null;
    const rest: string[] = [];
    for (let i = 1; i < toks.length; i++) {
      const a = toks[i];
      if ((a === '-s' || a === '--seconds') && toks[i + 1]) {
        const v = parseInt(toks[++i], 10);
        if (!Number.isFinite(v) || v <= 0) return false;
        intervalSeconds = v;
      } else if ((a === '-c' || a === '--count') && toks[i + 1]) {
        const v = parseInt(toks[++i], 10);
        if (!Number.isFinite(v) || v <= 0) return false;
        count = v;
      } else {
        rest.push(a);
      }
    }
    if (intervalSeconds === null) return false;
    const shell = this.shell;
    const rendered = ['free', ...rest].join(' ').trim();
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: Math.max(100, intervalSeconds * 1000),
      maxFrames: count ?? undefined,
      frame: () => dev.runCommandFrameInSession(rendered, shell),
    });
  }

  private tryStartVmstatStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'vmstat') return false;
    const parsed = parseVmstatArgs(toks.slice(1));
    if ('error' in parsed) return false;
    if (parsed.intervalSeconds === null) return false;
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: Math.max(100, parsed.intervalSeconds * 1000),
      maxFrames: parsed.count ?? undefined,
      header: () => vmstatHeader(parsed),
      frame: () => formatVmstatRow(dev.sampleVmstatSnapshot(), parsed),
    });
  }

  private tryStartMpstatStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'mpstat') return false;
    const parsed = parseMpstatArgs(toks.slice(1));
    if ('error' in parsed) return false;
    if (parsed.intervalSeconds === null) return false;
    const accumulator = new MpstatAccumulator();
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: Math.max(100, parsed.intervalSeconds * 1000),
      maxFrames: parsed.count ?? undefined,
      header: () => `${dev.mpstatBannerLine()}\n${mpstatColumnHeader(new Date())}`,
      frame: () => {
        const rows = dev.sampleMpstatSnapshot(parsed);
        accumulator.add(rows);
        const now = new Date();
        return rows.map((r) => formatMpstatRow(now, r)).join('\n');
      },
      trailer: () => {
        if (accumulator.sampleCount() === 0) return '';
        const lines = ['', ...accumulator.averages().map((r) => formatMpstatAverageRow(r))];
        return lines.join('\n');
      },
    });
  }

  private tryStartPidstatStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'pidstat') return false;
    const parsed = parsePidstatArgs(toks.slice(1));
    if ('error' in parsed) return false;
    if (parsed.intervalSeconds === null) return false;
    if (parsed.report === 'cpu') {
      const accumulator = new PidstatAccumulator<PidstatCpuRow>('cpu');
      return this.startScrollingMonitor({
        commandLine,
        intervalMs: Math.max(100, parsed.intervalSeconds * 1000),
        maxFrames: parsed.count ?? undefined,
        header: () => `${dev.pidstatBannerLine()}\n${pidstatColumnHeader(parsed, new Date())}`,
        frame: () => {
          const rows = dev.samplePidstatCpu(parsed);
          accumulator.add(rows);
          const now = new Date();
          return rows.map((r) => formatPidstatCpuRow(now, r)).join('\n');
        },
        trailer: () => {
          if (accumulator.sampleCount() === 0) return '';
          return ['', ...accumulator.averages().map((r) => formatPidstatAverageCpuRow(r))].join('\n');
        },
      });
    }
    const accumulator = new PidstatAccumulator<PidstatMemRow>('memory');
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: Math.max(100, parsed.intervalSeconds * 1000),
      maxFrames: parsed.count ?? undefined,
      header: () => `${dev.pidstatBannerLine()}\n${pidstatColumnHeader(parsed, new Date())}`,
      frame: () => {
        const rows = dev.samplePidstatMemory(parsed);
        accumulator.add(rows);
        const now = new Date();
        return rows.map((r) => formatPidstatMemRow(now, r)).join('\n');
      },
      trailer: () => {
        if (accumulator.sampleCount() === 0) return '';
        return ['', ...accumulator.averages().map((r) => formatPidstatAverageMemRow(r))].join('\n');
      },
    });
  }

  private tryStartIostatStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'iostat') return false;
    const parsed = parseIostatArgs(toks.slice(1));
    if ('error' in parsed) return false;
    if (parsed.intervalSeconds === null) return false;
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: Math.max(100, parsed.intervalSeconds * 1000),
      maxFrames: parsed.count ?? undefined,
      header: () => dev.iostatBannerLine(),
      frame: () => `\n${renderIostatReport(
        parsed,
        dev.sampleIostatCpuSnapshot(),
        dev.sampleIostatDevicesSnapshot(parsed),
        new Date(),
      )}`,
    });
  }

  private tryStartDstatStream(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine)) return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'dstat') return false;

    const parsed = parseDstatArgs(toks.slice(1));
    if (parsed.showHelp) { this.addLine(DSTAT_USAGE); this.notify(); return true; }
    if (parsed.showVersion) { this.addLine(DSTAT_VERSION); this.notify(); return true; }
    if (parsed.listStats) { this.addLine(DSTAT_LISTING); this.notify(); return true; }
    if (parsed.parseError) { this.addLine(parsed.parseError); this.notify(); return true; }

    const rate = newDstatRateState();
    return this.startScrollingMonitor({
      commandLine,
      intervalMs: Math.max(100, parsed.intervalSeconds * 1000),
      maxFrames: parsed.count ?? undefined,
      header: () => formatDstatHeader(parsed.groups),
      frame: () => formatDstatRow(dev.sampleDstatSnapshot(rate), parsed.groups),
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

  private async executeCommand(cmd: string, opts?: { echo?: boolean }): Promise<void> {
    const typed = cmd.trim();
    const trimmed = this.resolveActionLine(typed);

    // Multi-line commands assembled by the PS2 continuation loop already
    // echoed each physical line live; re-echoing here would duplicate them.
    if (opts?.echo !== false) this.addEchoLine(this.getPrompt(), cmd);

    // A pending visudo "What now?" recovery prompt consumes the very next
    // line typed (e/x/Q) before anything else is interpreted as a command.
    if (this.tryVisudoPromptResponse(typed)) return;
    if (this.tryCrontabPromptResponse(typed)) return;

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
    if (this.tryStartMtrStream(trimmed)) return;
    if (this.tryStartWatchStream(trimmed)) return;
    if (this.tryStartTopStream(trimmed)) return;
    if (this.tryStartJournalFollow(trimmed)) return;
    if (this.tryStartIpMonitor(trimmed)) return;
    if (this.tryStartDmesgFollow(trimmed)) return;
    if (this.tryStartNetstatStream(trimmed)) return;
    if (this.tryStartVmstatStream(trimmed)) return;
    if (this.tryStartFreeStream(trimmed)) return;
    if (this.tryStartMpstatStream(trimmed)) return;
    if (this.tryStartPidstatStream(trimmed)) return;
    if (this.tryStartIostatStream(trimmed)) return;
    if (this.tryStartDstatStream(trimmed)) return;
    if (this.tryStartTcpdump(trimmed)) return;
    if (this.tryCrontabEdit(trimmed)) return;
    if (this.tryVisudoEdit(trimmed)) return;
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
      if (parts[0] === 'ftp') {
        this.enterFtp(parts.slice(1));
        return;
      }
      if (parts[0] === 'nslookup' && parts.length === 1) {
        this.enterNslookup();
        return;
      }
      if (parts[0] === 'nsupdate' && !nsupdateNamesAFile(parts.slice(1))) {
        this.enterNsupdate(parts.slice(1));
        return;
      }
      if (parts[0] === 'ssh') {
        await this.enterSsh(parts.slice(1));
        return;
      }
      if (parts[0] === 'telnet') {
        await this.enterTelnet(parts.slice(1));
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

  private rootCompletionSource(): LastWordSource {
    const dev = this.device;
    return new LastWordSource(
      (line) => (this.shell && dev instanceof LinuxMachine)
        ? dev.getCompletionsForSession(line, this.shell)
        : this.device.getCompletions(line),
      { uniqueSpace: 'first-word' },
    );
  }

  protected onTab(): void {
    // Tab completion must run in *this* terminal's session context so that
    // path completion sees the per-session cwd, not the device-wide shared one.
    const out = this.rootCompletion.handleTab(this.input, this.rootCompletionSource(), false);
    if (!out.changed && out.suggestions === null) return;
    this.input = out.input;
    this.tabSuggestions = out.suggestions ? [...out.suggestions] : null;
    this.notify();
  }

  protected override computeGhostSuggestion(): string | null {
    if (this.activeSubShell || this.inputMode.type !== 'normal') return null;
    return ghostRemainder(this.input, this.rootCompletionSource());
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

    if (!dev.hasCrontab(user)) this.addLine(`no crontab for ${user} - using an empty one`);
    const template = dev.crontabEditTemplate(user);
    const tmpPath = `/tmp/crontab.${Math.floor(Math.random() * 1e6)}/crontab`;
    dev.writeFileFromEditorInSession(tmpPath, template, this.shell);
    this._pendingCrontabEdit = { user, tmpPath };
    this.openEditor(this.preferredEditor(), [tmpPath]);
    return true;
  }

  /** L'éditeur que `sensible-editor` choisirait : `$VISUAL`, puis `$EDITOR`. */
  private preferredEditor(): 'nano' | 'vi' | 'vim' {
    const v = (this.shell?.env.get('VISUAL') || this.shell?.env.get('EDITOR') || 'nano').toLowerCase();
    return v.includes('nano') ? 'nano' : v.includes('vim') ? 'vim' : v.includes('vi') ? 'vi' : 'nano';
  }

  /**
   * Le refus de `crontab -e`, et sa question. Le vrai ne jette pas une
   * édition fautive : il la garde et demande s'il faut la reprendre.
   */
  private _pendingCrontabPrompt: { user: string; tmpPath: string } | null = null;

  private tryCrontabPromptResponse(commandLine: string): boolean {
    const pending = this._pendingCrontabPrompt;
    if (!pending) return false;
    const answer = commandLine.trim().toLowerCase();
    if (answer === 'y') {
      this._pendingCrontabPrompt = null;
      this._pendingCrontabEdit = pending;
      this.openEditor(this.preferredEditor(), [pending.tmpPath]);
      return true;
    }
    if (answer === 'n') {
      this._pendingCrontabPrompt = null;
      this.addLine(`crontab: edits left in ${pending.tmpPath}`);
      this.notify();
      return true;
    }
    this.addLine('Do you want to retry the same edit? (y/n) ');
    this.notify();
    return true;
  }

  private finishCrontabEdit(saved: boolean): void {
    const pending = this._pendingCrontabEdit;
    this._pendingCrontabEdit = null;
    this.inputMode = { type: 'normal' };
    const dev = this.device;
    if (!saved || !(dev instanceof LinuxMachine) || !this.shell) {
      this.addLine('No modification made');
      this.notify();
      return;
    }
    const content = dev.readFileForEditorInSession(pending!.tmpPath, this.shell) ?? '';
    // Le vrai annonce l'installation avant de valider, puis se dédit si
    // le fichier ne passe pas. L'ordre est celui du relevé, pas une
    // approximation : les deux lignes sortent dans cet ordre-là.
    this.addLine('crontab: installing new crontab');
    const refus = validateCrontabContent(content, pending!.tmpPath);
    if (refus.length > 0) {
      for (const l of refus) this.addLine(l);
      this._pendingCrontabPrompt = pending;
      this.addLine('Do you want to retry the same edit? (y/n) ');
      this.notify();
      return;
    }
    dev.installCrontabContent(content, pending!.user);
    this.notify();
  }

  private _pendingVisudoEdit: { targetPath: string; tmpPath: string } | null = null;
  /** Set when a save was rejected for a syntax error — the exact real
   *  visudo "What now?" recovery prompt, awaiting e/x/Q on the next line. */
  private _pendingVisudoPrompt: { targetPath: string; tmpPath: string } | null = null;

  /** Print real visudo's "What now?" recovery menu after a rejected save. */
  private printVisudoWhatNow(errorLines: readonly string[]): void {
    for (const line of errorLines) this.addLine(line);
    this.addLine('What now?');
    this.addLine('Options are:');
    this.addLine("  (e)dit sudoers file again");
    this.addLine('  e(x)it without saving changes to sudoers file');
    this.addLine('  (Q)uit and save changes to sudoers file (DANGER!)');
    this.addLine('');
    this.addLine('What now? ');
  }

  /** Consumes the next typed line as the response to printVisudoWhatNow(). */
  private tryVisudoPromptResponse(commandLine: string): boolean {
    const pending = this._pendingVisudoPrompt;
    if (!pending) return false;
    const answer = commandLine.trim();
    const dev = this.device;

    if (answer === 'e') {
      this._pendingVisudoPrompt = null;
      this._pendingVisudoEdit = pending;
      const content = (dev instanceof LinuxMachine && this.shell)
        ? dev.readFileForEditorInSession(pending.tmpPath, this.shell) ?? ''
        : '';
      const editorVar = (this.shell?.env.get('VISUAL') || this.shell?.env.get('EDITOR') || 'vi').toLowerCase();
      const editorCmd: 'nano' | 'vi' | 'vim' = editorVar.includes('nano') ? 'nano' : editorVar.includes('vim') ? 'vim' : 'vi';
      this.openEditor(editorCmd, [pending.tmpPath]);
      void content; // buffer already lives at tmpPath — openEditor re-reads it
      return true;
    }
    if (answer === 'x') {
      this._pendingVisudoPrompt = null;
      this.addLine(`visudo: ${pending.targetPath} unchanged`);
      this.notify();
      return true;
    }
    if (answer === 'Q') {
      this._pendingVisudoPrompt = null;
      if (dev instanceof LinuxMachine && this.shell) {
        const content = dev.readFileForEditorInSession(pending.tmpPath, this.shell) ?? '';
        dev.writeFileFromEditorInSession(pending.targetPath, content, this.shell);
      }
      this.addLine(`visudo: ${pending.targetPath}: saved with a known syntax error (DANGER!)`);
      this.notify();
      return true;
    }
    // Any other input: invalid choice — real visudo re-prompts.
    this.printVisudoWhatNow([]);
    this.notify();
    return true;
  }

  /**
   * `visudo` (no `-c`) — real visudo edits a *temp copy* of the target
   * file and only installs it if the saved content parses cleanly,
   * guaranteeing /etc/sudoers is never left syntactically broken (which
   * would lock every admin out of sudo). `-c`/`-c -f` stay on the normal
   * LinuxCommand dispatch path (Visudo.ts) since they never touch the
   * editor at all.
   */
  private tryVisudoEdit(commandLine: string): boolean {
    const dev = this.device;
    if (!(dev instanceof LinuxMachine) || !this.shell) return false;
    const trimmedCmd = commandLine.trim();
    const isSudo = trimmedCmd.startsWith('sudo ');
    let toks = trimmedCmd.split(/\s+/);
    if (isSudo) toks = toks.slice(1);
    if (toks[0] !== 'visudo' || toks.includes('-c')) return false;

    // Session-scoped, not device-global: after `sudo su -` in THIS
    // terminal, `this.shell.user` is 'root' even though the device's
    // legacy executor-wide current user (dev.getCurrentUser()) never
    // changes — the same distinction every other check in this method
    // already respects via the `InSession` VFS calls below.
    const isRoot = this.shell.user === 'root';
    if (!isRoot && !(isSudo && dev.canSudo())) {
      this.addLine('visudo: you must be root to run visudo');
      return true;
    }

    const fIdx = toks.indexOf('-f');
    const targetArg = fIdx !== -1 && toks[fIdx + 1] ? toks[fIdx + 1] : '/etc/sudoers';
    const targetPath = dev.resolveAbsolutePathInSession(targetArg, this.shell);
    const existing = dev.readFileForEditorInSession(targetPath, this.shell) ?? '';

    const tmpPath = `/tmp/visudo.${Math.floor(Math.random() * 1e6)}`;
    dev.writeFileFromEditorInSession(tmpPath, existing, this.shell);
    this._pendingVisudoEdit = { targetPath, tmpPath };

    const editorVar = (this.shell.env.get('VISUAL') || this.shell.env.get('EDITOR') || 'vi').toLowerCase();
    const editorCmd: 'nano' | 'vi' | 'vim' = editorVar.includes('nano') ? 'nano' : editorVar.includes('vim') ? 'vim' : 'vi';
    this.openEditor(editorCmd, [tmpPath]);
    return true;
  }

  private finishVisudoEdit(saved: boolean): void {
    const pending = this._pendingVisudoEdit;
    this._pendingVisudoEdit = null;
    this.inputMode = { type: 'normal' };
    const dev = this.device;
    if (!saved || !(dev instanceof LinuxMachine) || !this.shell) {
      this.addLine('visudo: no changes made');
      this.notify();
      return;
    }
    const content = dev.readFileForEditorInSession(pending!.tmpPath, this.shell) ?? '';
    const result = validateSudoersContent(content, pending!.targetPath);
    if (result.exitCode !== 0) {
      // Real visudo never silently discards a rejected save — it asks
      // what to do next (re-edit / discard / force-save anyway).
      this._pendingVisudoPrompt = pending!;
      this.printVisudoWhatNow(result.lines);
    } else {
      dev.writeFileFromEditorInSession(pending!.targetPath, content, this.shell);
      // Real visudo always leaves sudoers-family files root-owned 0440,
      // regardless of the editing session's umask — a world/group-writable
      // (or non-root-owned) sudoers file is a privilege-escalation hole.
      dev.setSudoersFilePermissions(pending!.targetPath);
    }
    this.notify();
  }

  private openEditor(editorCmd: 'nano' | 'vi' | 'vim', args: string[]): void {
    let filePath = '';
    for (const arg of args) {
      if (!arg.startsWith('-') && !arg.startsWith('+')) { filePath = arg; break; }
    }
    // nano -v/--view: open read-only, no Write Out. nano -c/--constantshow:
    // title bar shows the live cursor position. Both no-ops for vi/vim
    // (which use their own :view / :set ruler commands for the same idea).
    const readOnly = editorCmd === 'nano' && args.some((a) => a === '-v' || a === '--view');
    const showPosition = editorCmd === 'nano' && args.some((a) => a === '-c' || a === '--constantshow');
    const showLineNumbers = editorCmd === 'nano' && args.some((a) => a === '-l' || a === '--linenumbers');
    // `+LINE[,COLUMN]` (nano) / `+LINE` (vim/vi, no column form) opens the
    // buffer with the cursor already positioned there. Real nano/vim take
    // the LAST such argument if more than one is given.
    let initialCursorLine: number | undefined;
    let initialCursorCol: number | undefined;
    for (const arg of args) {
      const m = /^\+(\d+)(?:,(\d+))?$/.exec(arg);
      if (m) {
        initialCursorLine = parseInt(m[1], 10);
        initialCursorCol = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
      }
    }

    // No filename given: a genuinely unnamed buffer. Resolving '' against
    // the cwd would collapse to the cwd's OWN directory path (VFS
    // normalizePath treats '' as "no extra segment"), so `^O`/`:w` would
    // silently target the directory itself — skip resolution entirely and
    // leave both paths empty; the engines already handle an empty
    // filePath correctly (nano's Write Out prompt starts blank, vim's :w
    // reports E32 until a real name is typed).
    if (!filePath) {
      this.inputMode = {
        type: 'editor',
        editorType: editorCmd,
        filePath: '',
        absolutePath: '',
        content: '',
        isNewFile: true,
        readOnly,
        showPosition,
        showLineNumbers,
        initialCursorLine,
        initialCursorCol,
      };
      this.notify();
      return;
    }

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
      readOnly,
      showPosition,
      showLineNumbers,
      initialCursorLine,
      initialCursorCol,
    };
    this.notify();
  }

  override editorSave(content: string, filePath: string): void {
    if (this.hasActiveChild) { super.editorSave(content, filePath); return; }
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
  override editorExit(saved: boolean = true): void {
    if (this.hasActiveChild) { super.editorExit(saved); return; }
    if (this._pendingCrontabEdit) { this.finishCrontabEdit(saved); return; }
    if (this._pendingVisudoEdit) { this.finishVisudoEdit(saved); return; }
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

  /**
   * Command-owned interactive flows (IoC): the DEVICE declares the
   * sudo/su/passwd/adduser dialogue via `interactionPlanFor`; this session
   * renders it. The session's only contributions are its per-terminal
   * identity and the subshell-entry patches (rman/sqlplus) below.
   */
  private buildDeviceFlowSteps(
    command: string,
    currentUser: string,
    currentUid: number,
  ): InteractiveStep[] | null {
    const device = this.device as unknown as {
      interactionPlanFor?: (
        line: string,
        ctx?: { currentUser?: string; currentUid?: number },
      ) => import('@/shell/interaction/CommandInteraction').CommandInteractionPlan | null;
    };
    if (typeof device.interactionPlanFor !== 'function') return null;
    const plan = device.interactionPlanFor(command, { currentUser, currentUid });
    return plan ? toInteractiveSteps(plan) : null;
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
      const steps = this.buildDeviceFlowSteps(command, currentUser, currentUid);
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
      const steps = this.buildDeviceFlowSteps(command, currentUser, currentUid);
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

    const steps = this.buildDeviceFlowSteps(command, currentUser, currentUid);
    if (!steps) return false;

    this.startFlowFromSteps(steps, command);
    return true;
  }

  /** Post-flow hook: sync device state and handle special actions (e.g. enter sqlplus). */
  protected override onFlowComplete(ctx: FlowContext): void {
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
    const ftpMeta = ctx.metadata.get('enter_ftp') as string | undefined;
    if (ftpMeta) {
      const { host, port, user } = JSON.parse(ftpMeta) as { host: string; port?: number; user: string };
      const password = ctx.values.get('ftp_password') ?? '';
      this.connectAndEnterFtp(host, port, user, password);
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

    const tcpConnector: TcpConnector = dialConnector(this.device);

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

  /** `ftp [user@]host [port]` (PRD-FTP-SFTP.md §2.1.11) — like `enterSftp()`, but for the plain FTP engine (`FtpClientSession`). */
  private enterFtp(args: string[]): void {
    const positional = args.filter((a) => !a.startsWith('-'));
    const target = positional[0] ?? '';
    if (!target) {
      this.addLine('usage: ftp [user@]host [port]', 'error');
      this.notify();
      return;
    }
    const user = target.includes('@') ? target.split('@')[0] : this.currentUser;
    const host = target.includes('@') ? target.split('@')[1] : target;
    const port = positional[1] ? parseInt(positional[1], 10) : undefined;

    const steps: InteractiveStep[] = [
      {
        type: 'password',
        prompt: 'Password: ',
        mask: 'hidden',
        storeAs: 'ftp_password',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          ctx.metadata.set('enter_ftp', JSON.stringify({ host, port, user }));
        },
      },
    ];
    this.startFlowFromSteps(steps, `ftp ${target}`);
  }

  private connectAndEnterFtp(host: string, port: number | undefined, user: string, password: string): void {
    const dev = this.device as unknown as {
      executor?: {
        vfs?: import('@/network/devices/linux/VirtualFileSystem').VirtualFileSystem;
        userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined };
      };
      getTcpStack?: () => import('@/network/tcp/TcpStack').TcpStack;
    };
    const localVfs = dev.executor?.vfs;
    if (!localVfs || !dev.getTcpStack) {
      this.addLine('ftp: this device does not support FTP', 'error');
      this.notify();
      return;
    }

    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const localIp = this.lookupSourceIp();
    const client = new FtpClientSession(dev.getTcpStack(), host, localIp, port);

    const banner = client.connect();
    if (!banner || banner.code !== 220) {
      this.addLine(`ftp: connect: Connection refused`, 'error');
      this.notify();
      return;
    }
    this.addLine(banner.lines.join('\n'));

    const userReply = client.sendCommand({ verb: 'USER', argument: user });
    const passReply = client.sendCommand({ verb: 'PASS', argument: password });
    if (!passReply || passReply.code !== 230) {
      this.addLine(passReply?.lines.join('\n') ?? 'Login failed.', 'error');
      client.close();
      this.notify();
      return;
    }
    if (userReply) this.addLine(userReply.lines.join('\n'));
    this.addLine(passReply.lines.join('\n'));

    const shell = new FtpSubShell({
      client,
      localVfs,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      localHome: homeDir,
      localCwd: this.currentPath,
    });
    this.activeSubShell = shell;
    this._inputBuf = '';
    this.notify();
  }

  /** `nslookup` with no arguments (PRD-Nslookup-Dig-Rndc-Runas.md §2.1.1) — real `nslookup(1)`'s interactive `>` REPL. */
  private enterNsupdate(args: string[]): void {
    const dev = this.device as unknown as {
      net?: import('@/network/devices/linux/LinuxNetKernel').LinuxNetKernel;
      executor?: import('@/network/devices/linux/LinuxCommandExecutor').LinuxCommandExecutor;
    };
    const sender = dev.executor?.dnsUpdateSender?.();
    if (!dev.net || !sender) {
      this.addLine('nsupdate: no DNS support on this host', 'error');
      this.notify();
      return;
    }
    let key: TsigKey | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '-y') continue;
      const parsed = parseNsupdateKeyOption(args[i + 1] ?? '');
      if (typeof parsed === 'string') {
        this.addLine(parsed, 'error');
        this.notify();
        return;
      }
      key = parsed;
    }
    const net = dev.net;
    this.activeSubShell = new NsupdateSubShell({
      send: sender,
      resolve: (name) => Promise.resolve(net.resolveHostname(name)),
      key,
    });
    this._inputBuf = '';
    this.notify();
  }

  private enterNslookup(): void {
    const dev = this.device as unknown as {
      net?: import('@/network/devices/linux/LinuxNetKernel').LinuxNetKernel;
      executor?: import('@/network/devices/linux/LinuxCommandExecutor').LinuxCommandExecutor;
    };
    if (!dev.net || !dev.executor) {
      this.addLine('nslookup: this device does not support DNS lookups', 'error');
      this.notify();
      return;
    }
    const initialServer = readResolverIP(dev.executor);
    const net = dev.net;
    const shell = new NslookupSubShell({
      query: (s, n, t, ms) => net.queryDns(s, n, t, ms),
      initialServer,
    });
    for (const line of shell.bannerLines()) this.addLine(line);
    this.activeSubShell = shell;
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
    //
    // Audit 03, constat CRITIQUE §1.b: non-Linux targets (Cisco/Huawei/
    // Windows) used to go through `tryEnterCrossVendorSsh()`, which
    // verified the password with a direct `sshHost.evaluate()` method
    // call — zero bytes on the wire — even though these devices already
    // run a real SshServerHandler on a real TcpStack.listen(22, ...)
    // (Router.ts, WindowsPC.ts). Every target now goes through the same
    // real SshSession/TcpStack pipeline Linux targets always used; the
    // security policy that pre-check enforced (login block-for,
    // quiet-mode ACL) is preserved via RouterSshServerContext's
    // isClientBlocked/recordAuthFailure hooks, now reachable from a real
    // auth exchange instead of a local call.
    await this.connectAndEnterSsh(merged);
  }

  /**
   * `telnet host [port]` — one real TCP connection to the remote VTY,
   * then a sub-shell over it. Every line printed afterwards is the
   * remote device's own text: the login dialog, the prompt and the
   * command output all come off the wire
   * (docs/PRD-VTY-Transport.md §2.1 item 6).
   */
  private async enterTelnet(args: string[]): Promise<void> {
    const vfs = (this.device as unknown as {
      executor?: { vfs?: { readFile(p: string): string | null } };
    }).executor?.vfs;
    const sub = await launchTelnet(args, {
      device: this.device,
      resolverVfs: vfs ? { readFile: (p: string) => vfs.readFile(p) } : undefined,
      emit: (text, type) => this.addLine(text, type),
    });
    if (!sub) { this.notify(); return; }

    this.activeSubShell = sub;
    this._inputBuf = '';
    const opening = await sub.begin();
    for (const line of opening.output) this.addLine(line);
    if (opening.exit) { this.exitSubShell(); return; }
    this.notify();
  }

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
    const tcpConnector: TcpConnector = dialConnector(this.device);
    const userEntry = dev.executor?.userMgr?.getUser(this.currentUser);
    const homeDir = userEntry?.home ?? `/home/${this.currentUser}`;
    const user = meta.userAtHost.includes('@')
      ? meta.userAtHost.split('@')[0]
      : this.currentUser;
    const typedHost = meta.userAtHost.includes('@')
      ? meta.userAtHost.split('@')[1]
      : meta.userAtHost;

    // Un vrai client résout le nom AVANT d'ouvrir la moindre socket, et
    // s'arrête là s'il n'y arrive pas. Sans cette étape, `ssh localhost`
    // descendait jusqu'à la pile TCP avec le mot « localhost » pour
    // adresse, où il levait une exception non rattrapée.
    const host = this.resolveSshHost(typedHost);
    if (!host) {
      this.addLine(
        `ssh: Could not resolve hostname ${typedHost}: Name or service not known`,
        'error',
      );
      this.notify();
      return;
    }

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

    // No usable path to the host — a real client fails here, before any
    // key exchange or password prompt (docs/PRD-Link-State.md §2.1 P6).
    const reachable = this.remoteLivenessProbe(host);
    if (reachable && !reachable()) {
      this.addLine(`ssh: connect to host ${host} port ${meta.port}: No route to host`, 'error');
      session.disconnect();
      this.pendingSshIO = null;
      this.notify();
      return;
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
          // A refused connection is `Connection refused`, not `No route to
          // host` — the unreachable case was already decided above, by the
          // liveness probe, before any session was opened, so reaching
          // here means the path was fine and the far end said no. That is
          // what a router in quiet-mode, a `transport input none`, or a
          // stopped daemon look like from the client, and calling it a
          // routing failure sends the operator to check cables instead.
          errKind === 'CONNECTION_REFUSED'
            ? `ssh: connect to host ${host} port ${meta.port}: Connection refused`
            : errKind === 'CONNECTION_TIMEOUT'
            ? `ssh: connect to host ${host} port ${meta.port}: Connection timed out`
            : errKind === 'HOST_KEY_REJECTED' || errKind === 'HOST_KEY_CHANGED'
            ? 'Host key verification failed.'
            : `${user}@${host}: Permission denied (publickey,password).`;
        this.addLine(msg, 'error');
      }
      // A failed connection attempt (bad auth, rejected host key, refused
      // admission, …) must not linger: a real ssh client tears down its
      // TCP connection on failure rather than leaving the vty/pty line it
      // occupied on the server dangling until some other timeout fires.
      session.disconnect();
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
    // Every forwarder needs the tunnel's OTHER end, so the peer is
    // resolved first: `-L`/`-D` are dialled by the server, `-R` by us.
    // Any peer holding a TCP stack can dial — a router and a Windows
    // machine both have one — so the dialler is not narrowed to a
    // LinuxMachine the way `-R`'s listener below is.
    const linuxRemoteDevice = findLinuxMachineByIp(host);
    const dialPeer = linuxRemoteDevice ?? findEquipmentByIp(host);
    // OpenSSH `-L`: register local-port forwarders on the local device,
    // each tunnelling new connections through this SSH session.
    const forwarders = this.installLocalForwards(session, host, meta, dialPeer);
    // OpenSSH `-D`: SOCKS proxy on a local port — symmetric placement to
    // `-L` (always on the local device).
    const dynamicForwarders = this.installDynamicForwards(session, host, meta, dialPeer);
    // OpenSSH `-R`: needs the remote device — registered only when the
    // SSH peer resolves to a local Equipment instance (the common case
    // for the tutorial LAN).
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

    // Every vendor is driven over the real, authenticated SSH channel.
    // The server shells became stateful (A2/A3), publish their prompt
    // and completion (A1/B1), stack their own sub-shells (B2), host
    // their own editors (B3) and raise their own challenges (B4), so
    // one client driver is left (docs/PRD-SSH-Unification.md §4bis).
    const wireRemoteDevice = linuxRemoteDevice ?? findEquipmentByIp(host);
    if (wireRemoteDevice) {
      const channelResult = session.openShellChannel();
      if (isOk(channelResult)) {
        const sourceIp = this.firstLocalIp() ?? '0.0.0.0';
        const sourceHost = this.device.getHostname?.() ?? '';
        const banner = this.composeLoginBanner(wireRemoteDevice, user, sourceIp, sourceHost, false);
        for (const line of banner) this.addLine(line);
        const promptHost = (wireRemoteDevice as unknown as { getSshHostname?: () => string })
          .getSshHostname?.() ?? host;
        this.activeSubShell = new SshInteractiveSubShell(
          session, channelResult.value, user, host, `/home/${user}`, onSessionEnd,
          promptHost, linuxRemoteDevice ?? undefined,
          // Liveness of an OPEN session is read, never provoked with a
          // fresh handshake — otherwise every command would make the
          // remote log an accept/close pair. Two facts are read: this
          // side's own socket, which knows when THIS link drops, and the
          // path, which is the only thing that notices a cable pulled at
          // the far end, a switch losing power in between, or the peer
          // being switched off (docs/PRD-Pannes.md §F1, §F5).
          establishedSessionLiveness(session, this.device, host),
          (footer) => this.onRemoteHangup(footer),
          (line) => this.addLine(line),
        );
        this._inputBuf = '';
        this.notify();
        return;
      }
    }

    const anyRemoteDevice = linuxRemoteDevice ?? findEquipmentByIp(host);
    if (anyRemoteDevice) {
      const child = createSessionForDevice(anyRemoteDevice, `${this.id}>ssh`);
      if (child) {
        const clientIp = this.firstLocalIp() ?? '0.0.0.0';
        const serverIp = host;
        const clientPort = 50_000 + (user.length * 7 % 10_000);
        this.adoptRemoteChild(child, user, host, {
          SSH_CONNECTION: `${clientIp} ${clientPort} ${serverIp} 22`,
          SSH_CLIENT: `${clientIp} ${clientPort} 22`,
        });
        child.registerTearDown(onSessionEnd);
        return;
      }
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
    const tcpConnector: TcpConnector = dialConnector(this.device);

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
    const tcpConnector: TcpConnector = dialConnector(this.device);
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
   * Open `line` as an editor on the remote when the active sub-shell is
   * an SSH session and the remote accepts it. The engine stays on the
   * remote; the overlay drives it through a proxy over the same channel.
   * Returns false when the line is not an editor invocation at all, so
   * the caller runs it as a normal command.
   */
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

      // An editor typed in a remote session opens on the remote, where
      // the file is. Only once the remote declines does the line run as
      // an ordinary command (docs/PRD-SSH-Unification.md §4bis B3).
      if (this.tryOpenRemoteEditor(line)) return true;

      const onProgress = (text: string) => { this.addLine(text); this.notify(); };
      const maybePromise = this.activeSubShell.processLine(line, onProgress);

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
      if (this.activeSubShell.interruptForeground?.()) {
        this.notify();
        return true;
      }
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

    // Tab is ALWAYS consumed while a sub-shell is active — even when the
    // sub-shell offers no completions — so it never leaks to the browser's
    // native focus navigation.
    if (e.key === 'Tab') {
      this.onSubShellTab(e.shiftKey ?? false);
      return true;
    }

    // `?` is a help key on a network CLI and an ordinary character on a
    // POSIX shell, so only a remote that advertises inline help gets the
    // interception — `ls ?.txt` over SSH to Linux still types a `?`.
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey
        && this.subShellOffersInlineHelp()) {
      void this.showSubShellInlineHelp();
      return true;
    }

    // Any other key ends a completion cycle and clears the suggestions.
    this.subShellCompletion.reset();
    if (this.tabSuggestions) {
      this.tabSuggestions = null;
      this.notify();
    }

    // Let the view handle other keys (typing into the interactive-text input)
    return false;
  }

  private subShellOffersInlineHelp(): boolean {
    const sub = this.activeSubShell as { supportsInlineHelp?: () => boolean } | null;
    return sub?.supportsInlineHelp?.() === true;
  }

  /**
   * Echo the composed line with `?`, print the device's help, then hand
   * the line back for editing — what a real console does when `?` is
   * pressed mid-command (docs/PRD-SSH-Unification.md §4bis B1).
   */
  private async showSubShellInlineHelp(): Promise<void> {
    const sub = this.activeSubShell as
      { inlineHelpAsync?: (line: string) => Promise<string[]>; getPrompt(): string } | null;
    if (!sub?.inlineHelpAsync) return;
    const line = this._inputBuf;
    this.addEchoLine(sub.getPrompt(), `${line}?`);
    for (const helpLine of await sub.inlineHelpAsync(line)) this.addLine(helpLine);
    this.notify();
  }

  private onSubShellTab(reverse: boolean): void {
    const sub = this.activeSubShell;
    if (!sub) return;
    if (typeof sub.getCompletionsAsync === 'function') {
      void this.onSubShellTabAsync(sub, reverse);
      return;
    }
    if (typeof sub.getCompletions !== 'function') return;
    this.applySubShellTab((line) => sub.getCompletions?.(line) ?? [], reverse);
  }

  /**
   * Tab against a sub-shell that can only answer asynchronously (a remote
   * shell over an SSH channel). The candidates are fetched first, then fed
   * to the same synchronous completion controller; a keystroke landing
   * while the request is in flight abandons the stale answer
   * (docs/PRD-SSH-Unification.md §4bis B1).
   */
  private async onSubShellTabAsync(sub: ISubShell, reverse: boolean): Promise<void> {
    const asked = this._inputBuf;
    const candidates = await sub.getCompletionsAsync!(asked);
    if (this._inputBuf !== asked) return;
    this.applySubShellTab(() => candidates, reverse);
  }

  private applySubShellTab(fetch: (line: string) => readonly string[], reverse: boolean): void {
    const source = new LastWordSource(fetch, { uniqueSpace: 'never' });
    const out = this.subShellCompletion.handleTab(this._inputBuf, source, reverse);
    if (!out.changed && out.suggestions === null) return;
    this._inputBuf = out.input;
    this.tabSuggestions =
      out.suggestions && out.suggestions.length > 1 ? [...out.suggestions] : null;
    this.notify();
  }

  /**
   * The remote hung the line up with nothing typed here — an IOS VTY
   * `exec-timeout` firing server-side. Real ssh prints its footer the
   * moment the socket dies and hands the shell back, so the footer and
   * the local prompt land without waiting for the next keypress.
   */
  private onRemoteHangup(footer: string): void {
    if (!this.activeSubShell) return;
    this.addLine(footer);
    this.exitSubShell();
    this.addLine(this.getPrompt());
    this.notify();
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
  /**
   * Is there a usable path to `host` from THIS device, before `ssh`
   * connects. Read off the cabled topology rather than dialled: the
   * connection `ssh` is about to open is the one that settles the
   * question, and a throwaway handshake before it made the server log an
   * accept/close pair for a connection no client ever had
   * (docs/PRD-Link-State.md §2.1 P6).
   */
  private remoteLivenessProbe(host: string): (() => boolean) | undefined {
    if (!IPAddress.tryParse(host)) return undefined;
    return peerLiveness(this.device, host);
  }

  /**
   * Le nom que l'opérateur a tapé, ramené à une adresse — ce qu'un vrai
   * client ssh fait AVANT d'ouvrir quoi que ce soit.
   *
   * Rien ne le faisait : `ssh localhost` descendait jusqu'à
   * `TcpStack.resolveEgress`, qui construisait `new IPAddress('localhost')`
   * et levait. L'exception remontait par une promesse non rattrapée, donc
   * l'utilisateur voyait une trace de pile au lieu d'une session ou d'un
   * refus.
   *
   * L'ordre est celui du résolveur réel : une adresse littérale passe
   * telle quelle, puis `/etc/hosts` de la machine locale — c'est lui qui
   * porte `localhost` —, puis les noms d'équipements du réseau simulé.
   * `null` signifie « nom inconnu », et l'appelant rend alors le message
   * d'OpenSSH plutôt que d'appeler une adresse qui n'existe pas.
   */
  private resolveSshHost(host: string): string | null {
    if (IPAddress.tryParse(host)) return host;
    const vfs = (this.device as unknown as {
      executor?: { vfs?: { readFile(p: string): string | null } };
    }).executor?.vfs;
    if (vfs) {
      const needle = host.toLowerCase();
      const short = needle.split('.')[0];
      const raw = vfs.readFile('/etc/hosts');
      for (const entry of HostsFile.parse(raw).entries) {
        if (entry.hasName(needle) || entry.hasName(short)) return entry.ip;
      }
    }
    const found = findHostByAddress(
      host,
      vfs ? { readFile: (p: string) => vfs.readFile(p) } : undefined,
      this.device as never,
    );
    return found?.ip ?? null;
  }

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

  get isInsideSshSession(): boolean {
    return this.sshStack.length > 0 || this.hasActiveChild
      || this.activeSubShell?.connection === 'ssh';
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
    peerDevice: unknown,
  ): SshLocalForwarder[] {
    const forwards = meta.localForwards ?? [];
    if (forwards.length === 0) return [];
    const localDevice = this.getLocalDevice() as unknown as
      import('@/network/devices/EndHost').EndHost;
    if (typeof (localDevice as { getTcpStack?: unknown }).getTcpStack !== 'function') {
      return [];
    }
    const dialDevice = asDialDevice(peerDevice);
    const out: SshLocalForwarder[] = [];
    for (const fwd of forwards) {
      const forwarder = new SshLocalForwarder(localDevice, session, {
        localPort: fwd.localPort,
        remoteHost: fwd.remoteHost,
        remotePort: fwd.remotePort,
        sshHost,
      }, dialDevice);
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
    peerDevice: unknown,
  ): SshDynamicForwarder[] {
    const forwards = meta.dynamicForwards ?? [];
    if (forwards.length === 0) return [];
    const localDevice = this.getLocalDevice() as unknown as
      import('@/network/devices/EndHost').EndHost;
    if (typeof (localDevice as { getTcpStack?: unknown }).getTcpStack !== 'function') {
      return [];
    }
    const dialDevice = asDialDevice(peerDevice);
    const out: SshDynamicForwarder[] = [];
    for (const fwd of forwards) {
      const forwarder = new SshDynamicForwarder(localDevice, session, {
        socksPort: fwd.socksPort,
        bindAddress: fwd.bindAddress,
        sshHost,
      }, dialDevice);
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
      }, asDialDevice(this.getLocalDevice()));
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
function findEquipmentByIp(targetIp: string): Equipment | null {
  const all = EquipmentRegistry.getInstance().getAll();
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

function findLinuxMachineByIp(targetIp: string): LinuxMachine | null {
  const eq = findEquipmentByIp(targetIp);
  if (eq && eq instanceof LinuxMachine) return eq;
  return null;
}

/**
 * The tunnel's far end must be able to open a socket for the forwarder to
 * relay anything. A peer that resolves to nothing — or to an Equipment
 * with no TCP stack — leaves the listener refusing connections, which is
 * what the user sees when the forward cannot be served.
 */
function asDialDevice(
  candidate: unknown,
): import('@/network/devices/EndHost').EndHost | null {
  if (!candidate) return null;
  if (typeof (candidate as { getTcpStack?: unknown }).getTcpStack !== 'function') {
    return null;
  }
  return candidate as import('@/network/devices/EndHost').EndHost;
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

export { isEditorSegment } from '@/network/devices/linux/editors/editorLaunch';

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

function dialConnector(device: unknown): TcpConnector {
  const dev = device as {
    tcpDial?(destination: DialAddress, port: PortNumber): Promise<unknown>;
    tcpConnect?(host: string, port: number): Promise<unknown>;
  };
  return (host, port) => {
    const destination = parseDialAddress(host);
    const dialled = PortNumber.isValid(port) ? PortNumber.of(port) : null;
    if (destination && dialled && dev.tcpDial) {
      return dev.tcpDial(destination, dialled) as ReturnType<TcpConnector>;
    }
    return (dev.tcpConnect?.(host, port) ?? Promise.resolve(null)) as ReturnType<TcpConnector>;
  };
}

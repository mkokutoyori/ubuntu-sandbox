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
  KeyEvent, InputMode,
} from './TerminalSession';
import { AnsiOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { completeInput } from '@/terminal/core/TabCompletionHelper';
import { LinuxFlowBuilder } from '@/terminal/flows/LinuxFlowBuilder';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { RmanSubShell } from '@/terminal/subshells/RmanSubShell';
import { SftpSubShell } from '@/terminal/subshells/SftpSubShell';
import { RemoteShellSubShell } from '@/terminal/subshells/RemoteShellSubShell';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SshSession } from '@/network/protocols/ssh/session/SshSession';
import { SshConnectOptionsBuilder } from '@/network/protocols/ssh/SshConnectOptions';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { isOk } from '@/network/protocols/ssh/Result';
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

  constructor(id: string, device: Equipment) {
    super(id, device);
    this.currentPath = device.getCwd() || '/home/user';
    this.currentUser = device.getCurrentUser() || 'user';
  }

  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

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
    const p = this.getPromptParts();
    return { left: `${p.user}@${p.hostname}: ${p.path}` };
  }

  async init(): Promise<void> {
    // Linux terminal has no boot sequence — ready immediately
  }

  // ── Input mode ──────────────────────────────────────────────────

  override get currentInputMode(): InputMode {
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
      const exitResult = this.device.handleExit();
      if (exitResult.inSu) {
        if (exitResult.output) this.addLine(exitResult.output);
        this.syncDeviceState();
        return;
      }
      // Signal close — the view/manager will handle it
      this._onRequestClose?.();
      return;
    }

    // Add to history
    this.pushHistory(trimmed);

    // Intercept editor commands
    {
      const noSudo = trimmed.startsWith('sudo ') ? trimmed.slice(5).trim() : trimmed;
      const parts = noSudo.split(/\s+/);
      const editorCmd = parts[0];
      if (editorCmd === 'nano' || editorCmd === 'vi' || editorCmd === 'vim') {
        this.openEditor(editorCmd as 'nano' | 'vi' | 'vim', parts.slice(1));
        return;
      }
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
        this.addLine(`\x1b[31mConnection lost: device is powered off\x1b[0m`, 'error');
        this.inputMode = { type: 'normal' };
      } else if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine(`\x1b[31mCommand timed out\x1b[0m`, 'error');
      } else {
        this.addLine(`Error: ${err}`, 'error');
      }
    }
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(): void {
    const completions = this.device.getCompletions(this.input);
    if (completions.length === 0) return;

    const result = completeInput(this.input, completions);
    this.input = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }

  // ── Editor integration ──────────────────────────────────────────

  private openEditor(editorCmd: 'nano' | 'vi' | 'vim', args: string[]): void {
    let filePath = '';
    for (const arg of args) {
      if (!arg.startsWith('-') && !arg.startsWith('+')) { filePath = arg; break; }
    }
    if (!filePath) filePath = editorCmd === 'nano' ? 'New Buffer' : '';

    const absolutePath = this.device.resolveAbsolutePath(filePath);
    const existingContent = this.device.readFileForEditor(absolutePath);
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
    this.device.writeFileFromEditor(filePath, content);
  }

  /** Called by the view when editor exits. */
  editorExit(): void {
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  // ── Device state sync ───────────────────────────────────────────

  private syncDeviceState(): void {
    const cwd = this.device.getCwd();
    if (cwd) this.currentPath = cwd;
    this.currentUser = this.device.getCurrentUser();
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
      const { userAtHost } = JSON.parse(sftpMeta) as { userAtHost: string };
      const password = ctx.values.get('sftp_password') ?? '';
      this.connectAndEnterSftp(userAtHost, password);
      return;
    }
    const sshMeta = ctx.metadata.get('enter_ssh') as string | undefined;
    if (sshMeta) {
      const meta = JSON.parse(sshMeta) as {
        userAtHost: string;
        port: number;
        identityFiles: string[];
        strict: 'yes' | 'no' | 'accept-new';
        command: string | null;
      };
      const password = ctx.values.get('ssh_password') ?? '';
      this.connectAndEnterSsh(meta, password);
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
      const { subShell, banner } = RmanSubShell.create(args);
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
    // Find the host argument (first non-flag token)
    const userAtHost = args.find(a => !a.startsWith('-')) ?? '';
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
          ctx.metadata.set('enter_sftp', JSON.stringify({ userAtHost: displayTarget }));
        },
      },
    ];
    this.startFlowFromSteps(steps, `sftp ${userAtHost}`);
  }

  private async connectAndEnterSftp(userAtHost: string, password: string): Promise<void> {
    const dev = this.device as unknown as {
      executor?: { vfs?: unknown; userMgr?: { getUser(name: string): { uid?: number; gid?: number; home?: string } | undefined } };
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

    this.activeSubShell = new SftpSubShell(session);
    this._inputBuf = '';
    this.notify();
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
    const { userAtHost, port, identityFiles, strict, command } = parsed;
    const user = userAtHost.includes('@')
      ? userAtHost.split('@')[0]
      : this.currentUser;
    const host = userAtHost.includes('@') ? userAtHost.split('@')[1] : userAtHost;
    const displayTarget = `${user}@${host}`;

    const steps: InteractiveStep[] = [
      {
        type: 'password',
        prompt: `${displayTarget}'s password: `,
        mask: 'hidden',
        storeAs: 'ssh_password',
      },
      {
        type: 'execute',
        action: async (ctx: FlowContext) => {
          ctx.metadata.set(
            'enter_ssh',
            JSON.stringify({
              userAtHost: displayTarget,
              port,
              identityFiles,
              strict,
              command,
            }),
          );
        },
      },
    ];
    this.startFlowFromSteps(steps, `ssh ${userAtHost}`);
  }

  private async connectAndEnterSsh(
    meta: {
      userAtHost: string;
      port: number;
      identityFiles: string[];
      strict: 'yes' | 'no' | 'accept-new';
      command: string | null;
    },
    password: string,
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

    const session = new SshSession({
      tcpConnector,
      vfs: localVfs as never,
      localUser: this.currentUser,
      localUid: userEntry?.uid ?? 1000,
      localGid: userEntry?.gid ?? 1000,
      knownHostsPath: `${homeDir}/.ssh/known_hosts`,
      interactionHandler: new SilentSshInteractionHandler(password),
    });

    const builder = SshConnectOptionsBuilder.create()
      .host(host)
      .user(user)
      .port(meta.port)
      .strictHostKeyChecking(meta.strict)
      .password(password);
    for (const id of meta.identityFiles) builder.addIdentityFile(id);

    const result = await session.connect(builder.build());
    if (!isOk(result)) {
      const errKind = (result as { error: { kind: string } }).error.kind;
      const msg =
        errKind === 'CONNECTION_REFUSED'
          ? `ssh: connect to host ${host} port ${meta.port}: No route to host`
          : errKind === 'HOST_KEY_REJECTED' || errKind === 'HOST_KEY_CHANGED'
          ? 'Host key verification failed.'
          : `${user}@${host}: Permission denied (publickey,password).`;
      this.addLine(msg, 'error');
      this.notify();
      return;
    }

    if (meta.command) {
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

    // BRD SSH-04: interactive — open a remote shell sub-shell.
    const motd = this.tryReadRemoteMotd(session);
    for (const line of motd) this.addLine(line);
    this.activeSubShell = new RemoteShellSubShell(session, user, host, `/home/${user}`);
    this._inputBuf = '';
    this.notify();
  }

  /** Best-effort MOTD fetch via a one-shot remote `cat /etc/motd`. */
  private tryReadRemoteMotd(session: SshSession): string[] {
    const channelResult = session.openExecChannel('cat /etc/motd 2>/dev/null');
    if (!isOk(channelResult)) return [];
    // Synchronous delivery: result is populated immediately by the simulator.
    const channel = channelResult.value;
    void channel.execute();
    const out = channel.stdout;
    channel.close();
    return out ? out.replace(/\n$/, '').split('\n') : [];
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
}

// ── ssh CLI argument parser ─────────────────────────────────────

interface ParsedSshArgs {
  userAtHost: string;
  port: number;
  identityFiles: string[];
  strict: 'yes' | 'no' | 'accept-new';
  command: string | null;
}

/**
 * Parse `ssh [-p port] [-i identity] [-o option=value] user@host [cmd...]`.
 * Returns null if no host argument is found.
 */
function parseSshArgs(args: string[]): ParsedSshArgs | null {
  let port = 22;
  const identityFiles: string[] = [];
  let strict: 'yes' | 'no' | 'accept-new' = 'accept-new';
  let host: string | null = null;
  const commandTokens: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (host) {
      commandTokens.push(arg);
      continue;
    }
    if (arg === '-p' && i + 1 < args.length) {
      port = Number.parseInt(args[++i], 10) || 22;
    } else if (arg === '-i' && i + 1 < args.length) {
      identityFiles.push(args[++i]);
    } else if (arg === '-o' && i + 1 < args.length) {
      const next = args[++i];
      const m = /^StrictHostKeyChecking=(yes|no|accept-new)$/i.exec(next);
      if (m) strict = m[1].toLowerCase() as ParsedSshArgs['strict'];
    } else if (!arg.startsWith('-')) {
      host = arg;
    }
  }
  if (!host) return null;
  return {
    userAtHost: host,
    port,
    identityFiles,
    strict,
    command: commandTokens.length > 0 ? commandTokens.join(' ') : null,
  };
}

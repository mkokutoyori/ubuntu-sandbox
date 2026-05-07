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
import {
  parseSshKeygenArgs,
  generateAndWriteKeyPair,
} from '@/network/protocols/ssh/SshKeygen';
import { sshCopyId } from '@/network/protocols/ssh/SshCopyId';
import { parseScpArgs } from '@/network/protocols/ssh/Scp';
import { SshConfig } from '@/network/protocols/ssh/SshConfig';
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
    /** Closing callback (e.g. ssh session disconnect). */
    onPop: () => void;
    /** Display string used in "Connection to <X> closed." line. */
    label: string;
  }> = [];

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
      // BRD SSH-04-R4/R5: when nested in an SSH session, exit/logout pops
      // back to the previous device instead of closing the terminal.
      if (this.sshStack.length > 0) {
        this.popRemoteDevice();
        return;
      }
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

    // BRD SSH-06: merge ~/.ssh/config defaults under CLI overrides.
    const merged = this.mergeWithSshConfig(parsed);
    const { userAtHost, port, identityFiles, strict, command } = merged;
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
    for (const id of this.autoDiscoverIdentityFiles(meta.identityFiles)) {
      builder.addIdentityFile(id);
    }

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

    // BRD SSH-04: interactive — try to push the remote device onto the
    // terminal stack so the user gets a true remote shell (editors,
    // tab-completion, history). If the remote machine cannot be
    // resolved (e.g. tests using a synthetic SshServerHandler), fall
    // back to the legacy RemoteShellSubShell which forwards each line.
    const motd = this.tryReadRemoteMotd(session);
    for (const line of motd) this.addLine(line);
    const lastLogin = this.tryReadLastLogin(session, user);
    if (lastLogin) this.addLine(lastLogin);

    const remoteDevice = findLinuxMachineByIp(host);
    if (remoteDevice) {
      this.pushRemoteDevice(remoteDevice, user, host, () => session.disconnect());
      return;
    }
    this.activeSubShell = new RemoteShellSubShell(session, user, host, `/home/${user}`);
    this._inputBuf = '';
    this.notify();
  }

  /** Best-effort `lastlog`-style line via remote `cat /var/log/lastlog.json`. */
  private tryReadLastLogin(session: SshSession, _user: string): string | null {
    const channelResult = session.openExecChannel(
      `last -i ${_user} 2>/dev/null | head -n 1`,
    );
    if (!isOk(channelResult)) return null;
    const channel = channelResult.value;
    void channel.execute();
    const out = channel.stdout.replace(/\n$/, '');
    channel.close();
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
  private mergeWithSshConfig(parsed: {
    userAtHost: string;
    port: number;
    identityFiles: string[];
    strict: 'yes' | 'no' | 'accept-new';
    command: string | null;
  }): typeof parsed {
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
    this.sshStack.push({
      device: this.device,
      user: this.currentUser,
      path: this.currentPath,
      onPop,
      label,
    });
    this.device = remote;
    this.currentUser = user;
    this.currentPath = remote.getCwd() || `/home/${user}`;
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
    this.currentUser = frame.user;
    this.currentPath = frame.path;
    this.notify();
  }

  /** True while the terminal is operating on a remote device. */
  get isInsideSshSession(): boolean {
    return this.sshStack.length > 0;
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

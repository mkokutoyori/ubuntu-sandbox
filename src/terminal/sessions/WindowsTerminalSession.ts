/**
 * WindowsTerminalSession — Windows CMD + PowerShell terminal model.
 *
 * PowerShell is a sub-shell of cmd.exe, using the same ISubShell
 * interface as SQL*Plus is for Linux bash. Shell nesting is supported
 * via a stack of ISubShell instances (cmd → PS → cmd → PS → …).
 *
 * Features:
 *   - Sub-shell architecture: PowerShell & nested cmd via ISubShell
 *   - Shell nesting with stack (same pattern as Linux sub-shells)
 *   - Tab completion (PS cmdlets + device file paths)
 */

import { Equipment } from '@/network';
import { primaryShellKindFor } from '@/shell/shellKind';
import {
  TerminalSession, TerminalTheme, SessionType, KeyEvent, nextLineId,
  withTimeout, DeviceOfflineError,
  type InputMode,
} from './TerminalSession';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { parseWinPingArgs, formatWinPingHeader, formatWinPingReplyLine, formatWinPingStats } from '@/network/devices/windows/WinPing';
import { formatWinTracertHeader, formatWinTracertHop } from '@/network/devices/windows/WinTracert';
import type { PingResult } from '@/network/devices/EndHost';
import type { AsyncJobContext } from '@/terminal/async';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { PlainOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { classifyWindowsLines } from '@/terminal/core/windowsOutputStyle';
import { completeInputCaseInsensitive } from '@/terminal/core/TabCompletionHelper';
import type { ISubShell, SubShellResult } from '@/terminal/subshells/ISubShell';
import {
  RemoteDeviceSubShell,
  LinuxPromptStrategy,
  CiscoPromptStrategy, strategyForShellKind,
  HuaweiPromptStrategy,
  WindowsPromptStrategy,
  type RemotePromptStrategy,
} from '@/terminal/subshells/RemoteDeviceSubShell';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { installDefaultShells } from '@/shell/registerDefaults';
import { PromiseInputBroker as PromiseInputBrokerCtor } from '@/shell/input';
import { ShellFactory } from '@/shell/ShellFactory';
import { CrossVendorRemoteShell } from '@/shell/CrossVendorRemoteShell';
import { ShellSubShellAdapter } from '@/shell/ShellSubShellAdapter';
import type { IShell } from '@/shell/IShell';
import { SshConnectionRequest } from '@/network/protocols/ssh/server/SshConnectionRequest';
import { SshKnownHostsFile } from '@/network/protocols/ssh/SshKnownHostsFile';

const WINDOWS_THEME: TerminalTheme = {
  sessionType: 'windows',
  backgroundColor: '#0c0c0c',
  textColor: '#cccccc',
  errorColor: '#f14c4c',
  promptColor: '#cccccc',
  fontFamily: "'Cascadia Mono', 'Consolas', 'Courier New', monospace",
  infoBarBg: '#0c0c0c',
  infoBarText: '#808080',
  infoBarBorder: '#333333',
  warningColor: '#cca700',
};

export class WindowsTerminalSession extends TerminalSession {
  bannerCleared: boolean = false;
  tabSuggestions: string[] | null = null;

  /**
   * Active Tab-completion cycle (PowerShell classic console behaviour:
   * repeated Tab walks the candidate list, replacing the token inline;
   * Shift+Tab walks backwards). Reset whenever a non-Tab key is pressed
   * or the input no longer matches what we last inserted.
   */
  private completion: {
    candidates: string[];
    index: number;
    /** Input text before the token being replaced. */
    prefix: string;
    /** The full _inputBuf we last wrote (to detect "Tab again"). */
    applied: string;
  } | null = null;

  private readonly _flowFormatter = new PlainOutputFormatter();
  private _onRequestClose?: () => void;
  private _onShellModeChange?: (mode: 'cmd' | 'powershell') => void;

  /** Active sub-shell (PowerShell or nested cmd). Null when in root cmd mode. */
  private activeSubShell: ISubShell | null = null;
  /** Stack of parent sub-shells for nesting (cmd → PS → cmd → …). */
  private subShellStack: ISubShell[] = [];
  /** Command history for the active sub-shell. */
  private subShellHistory: string[] = [];
  /** History navigation index for the active sub-shell (-1 = not navigating). */
  private subShellHistoryIndex: number = -1;
  /** Saved input before history navigation started. */
  private subShellSavedInput: string = '';
  /**
   * The pending input directive most recently requested by the active
   * sub-shell. When set, Enter on the host routes the collected value
   * back to the sub-shell via `handleInput` instead of `processLine`.
   */
  private subShellPendingInput: { kind: 'password' | 'text'; promptText: string } | null = null;

  /**
   * Per-terminal cmd.exe session — allocated on Windows machines so that
   * cwd / env / drive-cwd / history isolation is enforced per window.
   * Null when the underlying device does not support shell sessions.
   *
   * See terminal_gap.md §6.
   */
  shell: WindowsShellSession | null = null;

  constructor(id: string, device: Equipment) {
    super(id, device);
    if (device instanceof WindowsPC) {
      this.shell = device.openShellSession();
      this.registerTearDown(() => {
        const s = this.shell;
        if (s && device instanceof WindowsPC) device.closeShellSession(s);
        this.shell = null;
      });
    }
  }

  /**
   * Route command execution through the per-terminal session when one is
   * allocated, so that `cd D:\foo` / `set FOO=bar` mutate only this window
   * and not any other terminal on the same machine.
   */
  protected override async executeOnDevice(
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    const dev = this.device;
    if (!dev.getIsPoweredOn()) throw new DeviceOfflineError(dev.getName());
    if (this.shell && dev instanceof WindowsPC) {
      const p = dev.executeCommandInSession(command, this.shell);
      return timeoutMs != null ? withTimeout(p, timeoutMs) : p;
    }
    return super.executeOnDevice(command, timeoutMs);
  }

  getSessionType(): SessionType { return 'windows'; }
  getTheme(): TerminalTheme { return WINDOWS_THEME; }
  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

  /**
   * Current shell mode — derived from the active sub-shell type.
   * Used by UI components (TerminalModal, TerminalView) for display.
   */
  get shellMode(): 'cmd' | 'powershell' {
    if (this.activeSubShell instanceof ShellSubShellAdapter
        && this.activeSubShell.inner.kind === 'powershell') {
      return 'powershell';
    }
    return 'cmd';
  }

  /**
   * Shell stack depth — used by TerminalView to decide whether to show the CMD banner.
   * Returns an array-like with a length property for compatibility.
   */
  get shellStack(): { length: number } {
    return { length: this.subShellStack.length + (this.activeSubShell ? 1 : 0) };
  }

  getPrompt(): string {
    if (this.activeSubShell) {
      return this.activeSubShell.getPrompt();
    }
    // Per-session cwd is authoritative when allocated (terminal_gap.md §6);
    // falls back to the device-wide cwd for non-Windows devices or when
    // the shell session has been disposed.
    const cwd = this.shell?.cwd ?? (this.device as any).getCwd();
    return `${cwd}>`;
  }

  /**
   * Top of the active shell stack. When a sub-shell is pushed it's the
   * adapter wrapping that shell; otherwise null (root cmd path). The
   * adapter conforms to IShellBase via its inherited fields.
   */
  override get activeShell(): import('@/shell/IShellBase').IShellBase | null {
    return this.activeSubShell;
  }

  override get currentInputMode(): InputMode {
    if (this.inputHostImpl.hasPendingRequest()
        && (this.inputMode.type === 'password' || this.inputMode.type === 'interactive-text')) {
      return this.inputMode;
    }
    // A sub-shell that asked for a password challenge takes priority over
    // the normal interactive-text input — the host must mask keystrokes.
    if (this.activeSubShell && this.subShellPendingInput) {
      const p = this.subShellPendingInput;
      return p.kind === 'password'
        ? { type: 'password', promptText: p.promptText }
        : { type: 'interactive-text', promptText: p.promptText };
    }
    if (this.activeSubShell) {
      return { type: 'interactive-text', promptText: this.activeSubShell.getPrompt() };
    }
    return this.inputMode;
  }

  getInfoBarContent() {
    return { left: '' }; // Windows terminal has no info bar
  }

  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }
  onShellModeChange(cb: (mode: 'cmd' | 'powershell') => void): void { this._onShellModeChange = cb; }

  async init(): Promise<void> {
    // No boot sequence for Windows terminal — ready immediately
  }

  // ── Key handling ────────────────────────────────────────────────

  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;

    if (this.inputHostImpl.hasPendingRequest()) {
      if (this.handleBrokerKey(e)) return true;
    }

    // SSH password challenge — when an `ssh user@host` push is waiting
    // for the password, every keystroke routes through the password
    // mode (the input is masked by the view). Enter submits; Ctrl+C
    // aborts the challenge.
    if (this.pendingSshPush && this.inputMode.type === 'password') {
      if (e.key === 'Enter') {
        const pw = this.getPasswordBuf();
        this.setPasswordBuf('');
        this.submitSshPassword(pw);
        return true;
      }
      if (e.key === 'c' && e.ctrlKey) {
        this.pendingSshPush = null;
        this.sshPasswordAttempts = 0;
        this.setPasswordBuf('');
        this.inputMode = { type: 'normal' };
        this.addLine('^C');
        this.notify();
        return true;
      }
      // Let the view drive the character-by-character input into the
      // masked password buffer.
      return false;
    }

    // Sub-shell asked for a pending input value (typically a nested ssh
    // password). Capture it via password/text mode and feed it back to
    // the sub-shell's handleInput on Enter. Ctrl+C aborts.
    if (this.activeSubShell && this.subShellPendingInput) {
      if (e.key === 'Enter') {
        const value = this.subShellPendingInput.kind === 'password'
          ? this.getPasswordBuf()
          : this.getInputBuf();
        const directive = this.subShellPendingInput;
        this.subShellPendingInput = null;
        this.setPasswordBuf('');
        this.setInputBuf('');
        this.inputMode = { type: 'normal' };
        // Echo the prompt into scrollback once the user has submitted,
        // mirroring the OpenSSH challenge UX.
        if (directive.kind === 'password' && directive.promptText) {
          this.addLine(directive.promptText);
        }
        this.feedSubShellInput(value);
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
      return false; // Let the view drive char-by-char input.
    }

    // Sub-shell active (PowerShell or nested cmd) — route input there
    if (this.activeSubShell) {
      return this.handleSubShellKey(e);
    }

    return super.handleKey(e);
  }

  protected handleModeKey(_e: KeyEvent): boolean {
    return false; // Windows has no special modes (no pager, no boot keys)
  }

  protected handleNormalKey(e: KeyEvent): boolean {
    // Tab
    if (e.key === 'Tab') {
      this.onTab();
      return true;
    }

    // Clear tab suggestions on non-Tab key
    if (e.key !== 'Tab' && this.tabSuggestions) {
      this.tabSuggestions = null;
      this.notify();
    }

    // Escape → clear input
    if (e.key === 'Escape') {
      this.input = '';
      this.tabSuggestions = null;
      this.notify();
      return true;
    }

    // Ctrl+C
    if (e.key === 'c' && e.ctrlKey) {
      if (this.asyncRuntime.interruptForeground()) return true;
      this.addLine(`${this.getPrompt()}${this.input}^C`, 'warning');
      this.input = '';
      this.notify();
      return true;
    }

    // Ctrl+L
    if (e.key === 'l' && e.ctrlKey) {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return true;
    }

    return super.handleNormalKey(e);
  }

  // ── Command execution (root cmd mode) ──────────────────────────

  private tryStartWinPingStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    if (this.shellMode !== 'cmd' || this.activeSubShell) return false;
    const dev = this.device;
    if (!(dev instanceof WindowsPC)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0].toLowerCase() !== 'ping') return false;
    if (/[|<>&]/.test(commandLine)) return false;
    const parsed = parseWinPingArgs(toks.slice(1));
    if (!parsed.targetStr) return false;

    const count = parsed.continuous ? 0 : parsed.count;
    const results: PingResult[] = [];
    let label = parsed.targetStr;
    const emitStats = (ctx: AsyncJobContext) => {
      for (const line of formatWinPingStats(label, results.length, results)) ctx.sink.line(line);
    };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        const outcome = await dev.pingStreamInSession(parsed.targetStr, {
          count,
          ttl: parsed.ttl,
          timeoutMs: 2000,
          intervalMs: 1000,
          onResolved: (ip, hostname) => { label = ip.toString(); ctx.sink.line(formatWinPingHeader(ip, parsed.size, hostname)); },
          onResult: (r) => { results.push(r); ctx.sink.line(formatWinPingReplyLine(r, parsed.size)); },
          shouldStop: () => ctx.cancelled(),
          sleep: (ms) => ctx.delay(ms),
        });
        if (ctx.cancelled()) return;
        if (!outcome.resolved && results.length === 0) {
          ctx.sink.error(outcome.reason === 'name'
            ? `Ping request could not find host ${parsed.targetStr}. Please check the name and try again.`
            : 'Request timed out.');
          return;
        }
        emitStats(ctx);
      },
      onInterrupt: (ctx) => emitStats(ctx),
    });
    return job !== null;
  }

  private tryStartWinTracertStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    if (this.shellMode !== 'cmd' || this.activeSubShell) return false;
    const dev = this.device;
    if (!(dev instanceof WindowsPC)) return false;
    const toks = commandLine.trim().split(/\s+/);
    if (toks[0].toLowerCase() !== 'tracert') return false;
    if (/[|<>&]/.test(commandLine)) return false;
    if (toks.includes('/?') || toks.includes('/help')) return false;

    let targetStr = '';
    let maxHops = 30;
    const rest = toks.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i].toLowerCase();
      if (a === '-h' && rest[i + 1]) { maxHops = parseInt(rest[i + 1], 10) || 30; i++; }
      else if ((a === '-w' || a === '-j' || a === '-s') && rest[i + 1]) { i++; }
      else if (!a.startsWith('-') && !a.startsWith('/')) { targetStr = rest[i]; }
    }
    if (!targetStr) return false;

    let hopCount = 0;
    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        const outcome = await dev.tracerouteStreamInSession(targetStr, {
          maxHops,
          timeoutMs: 2000,
          onResolved: (ip, hostname) => {
            for (const line of formatWinTracertHeader(ip, maxHops, hostname)) ctx.sink.line(line);
          },
          onHop: (hop) => { hopCount++; for (const l of formatWinTracertHop(hop).split('\n')) ctx.sink.line(l); },
          shouldStop: () => ctx.cancelled(),
        });
        if (ctx.cancelled()) return;
        if (!outcome.resolved || hopCount === 0) {
          ctx.sink.error(`Unable to resolve target system name ${targetStr}.`);
          return;
        }
        ctx.sink.line('');
        ctx.sink.line('Trace complete.');
      },
    });
    return job !== null;
  }

  protected onEnter(): void {
    if (this.hasForegroundAsyncJob) {
      this.input = '';
      this._inputBuf = '';
      this.notify();
      return;
    }
    // Drain BOTH buffers so tests / drivers that keep using
    // `setInputBuf` after the sub-shell stack has fully unwound still
    // reach the local cmd.exe instead of being silently swallowed.
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

  private async executeCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    const prompt = this.getPrompt();

    this.addEchoLine(prompt, cmd);

    if (!trimmed) return;

    // Handle exit at root level → close terminal
    if (trimmed.toLowerCase() === 'exit') {
      this._onRequestClose?.();
      return;
    }

    this.pushHistory(trimmed);

    // Detect PowerShell launch from root cmd
    const lower = trimmed.toLowerCase();
    if (lower === 'powershell' || lower === 'powershell.exe' || lower === 'pwsh' || lower === 'pwsh.exe') {
      this.enterPowerShell();
      return;
    }

    // cls
    if (lower === 'cls') {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return;
    }

    if (this.tryStartWinPingStream(trimmed)) return;
    if (this.tryStartWinTracertStream(trimmed)) return;

    // SSH client info / unsupported forms — handled by the shared
    // launcher first so the OpenSSH usage / version line is uniform
    // across the local console and SSH'd-in shells.
    if (lower === 'ssh -v' || lower === 'ssh --version'
        || trimmed === 'ssh' /* bare ssh prints usage */) {
      if (lower === 'ssh -v' || lower === 'ssh --version') {
        this.addLine('OpenSSH_9.6p1 Ubuntu-3ubuntu13.4, OpenSSL 3.0.13 30 Jan 2024');
      } else {
        this.addLine('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface]');
        this.addLine('           [-b bind_address] [-c cipher_spec] [-D [bind_address:]port]');
        this.addLine('           [-E log_file] [-F configfile] [-I pkcs11] [-i identity_file]');
        this.addLine('           [-J [user@]host[:port]] [-L address] [-l login_name]');
        this.addLine('           [-o option] [-p port] [-Q query_option] [-R address]');
        this.addLine('           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]');
        this.addLine('           destination [command [argument ...]]');
      }
      this.notify();
      return;
    }

    // SSH interactive push: when the user types `ssh [user@]host` (no
    // remote command after the host), spawn an interactive remote
    // sub-shell against the resolved peer instead of falling through to
    // the device-level `cmdSsh` (which only prints the banner and the
    // closed line). Exec mode (`ssh user@host whoami`) falls through.
    if (lower === 'ssh' || lower.startsWith('ssh ')) {
      if (await this.tryEnterSshInteractive(trimmed)) {
        this.notify();
        return;
      }
    }

    // Execute on device (root cmd)
    try {
      const result = await this.executeOnDevice(trimmed);
      if (result !== undefined && result !== null && result !== '') {
        this.emitWindowsOutput(result);
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'DeviceOfflineError') {
        if (!this.isDisconnected) {
          this.addLine('Device is powered off — session disconnected', 'error');
        }
        return;
      }
      if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine('Command execution timed out', 'error');
      } else {
        this.addLine(`Error: ${err}`, 'error');
      }
    }

    this.notify();
  }

  // ── SSH interactive intercept ──────────────────────────────────

  /**
   * Parse `ssh [-flags] [user@]host [command...]`. Returns the parsed
   * shape when this is an *interactive* invocation (no command after the
   * host); returns `null` for malformed input or exec mode, letting the
   * caller fall through to the device-level `cmdSsh` (banner-only) path.
   *
   * The flag set mirrors the value-consuming short flags of OpenSSH so
   * `-p 2222 user@host` and `-l alice host` are routed correctly.
   */
  private parseInteractiveSsh(
    line: string,
  ): { user: string | null; host: string; port: number; quiet: boolean } | null {
    const parts = line.split(/\s+/).filter(p => p.length > 0);
    if (parts[0] !== 'ssh' || parts.length < 2) return null;
    const valueFlags = new Set([
      '-p', '-i', '-l', '-o', '-L', '-R', '-D', '-F', '-J',
      '-c', '-m', '-b', '-E', '-S', '-W', '-w',
    ]);
    let i = 1;
    let port = 22;
    let loginUser: string | null = null;
    let quiet = false;
    while (i < parts.length && parts[i].startsWith('-')) {
      const flag = parts[i];
      if (flag === '-q') { quiet = true; i++; continue; }
      if (flag === '-p' && parts[i + 1]) {
        const n = Number.parseInt(parts[i + 1], 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
        i += 2; continue;
      }
      if (flag === '-l' && parts[i + 1]) { loginUser = parts[i + 1]; i += 2; continue; }
      if (valueFlags.has(flag)) { i += 2; continue; }
      i++;
    }
    const target = parts[i];
    if (!target) return null;
    const remoteCmd = parts.slice(i + 1).join(' ').trim();
    if (remoteCmd) return null;

    const m = /^(?:([\w.\-\\]+)@)?([\w.-]+)$/.exec(target);
    if (!m) return null;
    return { user: m[1] ?? loginUser, host: m[2], port, quiet };
  }

  /**
   * Pick the interactive prompt strategy from the remote device's class
   * name — the same dispatch the Linux session uses, kept in sync so a
   * Cisco IOS peer always gets `Router#` regardless of the client side.
   */
  private pickRemoteStrategy(eq: { getOSType?: () => string }): RemotePromptStrategy {
    return strategyForShellKind(primaryShellKindFor(eq));
  }

  /** First configured IPv4 on the local Windows machine, or null. */
  private firstLocalIp(): string | null {
    for (const port of this.device.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && port.getIsUp()) return ip.toString();
    }
    return null;
  }

  private firstDeviceIp(dev: Equipment): string | null {
    for (const port of dev.getPorts()) {
      const ip = port.getIPAddress();
      if (ip) return ip.toString();
    }
    return null;
  }

  /**
   * Validate the target and, on success, push a {@link RemoteDeviceSubShell}
   * onto the Windows sub-shell stack so the user lands in an interactive
   * remote prompt (bash, IOS, VRP, cmd) — `exit` / `logout` / `quit` pops
   * back to the local cmd.exe. Returns `true` when the SSH path was
   * handled (success *or* a printed failure); `false` only when the
   * input is not interactive SSH (exec mode falls back to cmdSsh).
   */
  private async tryEnterSshInteractive(line: string): Promise<boolean> {
    const parsed = this.parseInteractiveSsh(line);
    if (!parsed) return false;

    const { host, port } = parsed;
    const sourceIp = this.firstLocalIp();
    if (!sourceIp) {
      this.addLine(`ssh: connect to host ${host} port ${port}: Network is unreachable`);
      return true;
    }

    const dev = this.device as unknown as {
      getHostname(): string;
      userMgr?: { currentUser: string };
    };
    const localUser = dev.userMgr?.currentUser ?? 'User';
    const user = parsed.user ?? localUser;

    const found = findHostByAddress(host);
    if (!found) {
      this.addLine(`ssh: Could not resolve hostname ${host}: Name or service not known`);
      return true;
    }
    if (found.poweredOff || found.interfaceDown) {
      this.addLine(`ssh: connect to host ${host} port ${port}: No route to host`);
      return true;
    }

    type RemoteSurface = {
      isSshActive?: () => boolean;
      sshdAcceptsLogin?: (u: string) => { ok: boolean; reason?: string };
      recordSshLogin?: (
        u: string, fromIp: string, fromHost: string, accepted: boolean,
      ) => void;
      sshBanner?: () => string;
      getSshHost?: () => { acceptsLogin?: (u: string) => { ok: boolean; reason?: string } };
    };
    const remote = found.device as unknown as RemoteSurface;
    const sshActive = typeof remote.isSshActive === 'function'
      ? remote.isSshActive()
      // Cross-vendor hosts expose service state through getSshHost().
      : (remote.getSshHost?.() as unknown as { isSshActive?: () => boolean })?.isSshActive?.() ?? false;
    if (!sshActive) {
      remote.recordSshLogin?.(user, sourceIp, dev.getHostname(), false);
      this.addLine(`ssh: connect to host ${host} port ${port}: Connection refused`);
      return true;
    }

    const gate = remote.sshdAcceptsLogin?.(user)
      ?? remote.getSshHost?.().acceptsLogin?.(user)
      ?? { ok: true };
    if (!gate.ok) {
      remote.recordSshLogin?.(user, sourceIp, dev.getHostname(), false);
      this.addLine(`${user}@${host}: Permission denied (publickey,password).`);
      return true;
    }

    // Stash the validated push so the password handler can finish it
    // after the user authenticates. OpenSSH-for-Windows always prompts
    // for a password on first connect (no key cached); the simulator
    // now models that explicitly instead of pushing silently.
    this.pendingSshPush = {
      user, host, port,
      device: found.device,
      sourceIp,
      sourceHostname: dev.getHostname(),
      quiet: parsed.quiet,
    };
    if (this.inputHostImpl.capabilities().interactive) {
      await this.runTopLevelSshAuthViaBroker();
      return true;
    }
    this.inputMode = { type: 'password', promptText: `${user}@${host}'s password: ` };
    this.addLine(`${user}@${host}'s password:`, 'prompt');
    this.notify();
    return true;
  }

  private async runTopLevelSshAuthViaBroker(): Promise<void> {
    const pending = this.pendingSshPush;
    if (!pending) return;
    const broker = new PromiseInputBrokerCtor(this.inputHostImpl);
    const promptText = `${pending.user}@${pending.host}'s password: `;
    for (;;) {
      const pw = await broker.password(promptText);
      if (pw === null) {
        this.pendingSshPush = null;
        this.sshPasswordAttempts = 0;
        this.inputMode = { type: 'normal' };
        this.notify();
        return;
      }
      const ok = this.verifyRemoteCredentials(pending.device, pending.user, pw);
      const remote = pending.device as unknown as {
        recordSshLogin?: (u: string, fromIp: string, fromHost: string, accepted: boolean) => void;
      };
      if (ok) {
        this.submitSshPassword(pw);
        return;
      }
      this.sshPasswordAttempts++;
      remote.recordSshLogin?.(pending.user, pending.sourceIp, pending.sourceHostname, false);
      if (this.sshPasswordAttempts >= WindowsTerminalSession.SSH_MAX_ATTEMPTS) {
        this.addLine(`${pending.user}@${pending.host}: Permission denied (publickey,password).`);
        this.pendingSshPush = null;
        this.sshPasswordAttempts = 0;
        this.inputMode = { type: 'normal' };
        this.notify();
        return;
      }
      this.addLine('Permission denied, please try again.');
    }
  }

  /**
   * Pending SSH push waiting for the password challenge to complete.
   * Set by {@link tryEnterSshInteractive} when validation succeeds.
   */
  private pendingSshPush: {
    user: string; host: string; port: number;
    device: Equipment; sourceIp: string; sourceHostname: string;
    quiet: boolean;
  } | null = null;

  /**
   * Drive the SSH password challenge. Up to three attempts are allowed
   * (OpenSSH default); a wrong password is logged via `recordSshLogin`
   * and surfaces as "Permission denied (publickey,password).".
   */
  private sshPasswordAttempts = 0;
  private static readonly SSH_MAX_ATTEMPTS = 3;

  private submitSshPassword(password: string): void {
    const pending = this.pendingSshPush;
    if (!pending) return;

    const ok = this.verifyRemoteCredentials(pending.device, pending.user, password);
    const remote = pending.device as unknown as {
      recordSshLogin?: (
        u: string, fromIp: string, fromHost: string, accepted: boolean,
      ) => void;
      sshBanner?: () => string;
    };

    if (!ok) {
      this.sshPasswordAttempts++;
      remote.recordSshLogin?.(
        pending.user, pending.sourceIp, pending.sourceHostname, false,
      );
      if (this.sshPasswordAttempts < WindowsTerminalSession.SSH_MAX_ATTEMPTS) {
        this.addLine('Permission denied, please try again.');
        // Stay in password mode for the next attempt.
        this.notify();
        return;
      }
      this.addLine(`${pending.user}@${pending.host}: Permission denied (publickey,password).`);
      this.pendingSshPush = null;
      this.sshPasswordAttempts = 0;
      this.inputMode = { type: 'normal' };
      this.notify();
      return;
    }

    remote.recordSshLogin?.(
      pending.user, pending.sourceIp, pending.sourceHostname, true,
    );
    if (!pending.quiet) {
      const banner = remote.sshBanner?.() ?? '';
      for (const line of banner.replace(/\n+$/, '').split('\n')) {
        if (line.length > 0) this.addLine(line);
      }
      const remoteMotd = (pending.device as unknown as { getSshMotd?: () => string });
      const motd = remoteMotd.getSshMotd?.() ?? '';
      for (const line of motd.replace(/\n+$/, '').split('\n')) {
        if (line.length > 0) this.addLine(line);
      }
    }
    this.writeKnownHostsEntry(pending.device, pending.host, pending.user);

    installDefaultShells();
    const primaryKind = this.pickPrimaryShellKind(pending.device);
    let activeShell: ISubShell;
    if (ShellFactory.has(primaryKind)) {
      // Compute the OpenSSH env strings so a remote `echo $SSH_CONNECTION`
      // returns "<client_ip> <client_port> <server_ip> <server_port>"
      // just like a real ssh login.
      const clientIp = this.firstLocalIp() ?? '0.0.0.0';
      const serverIp = this.firstDeviceIp(pending.device) ?? pending.host;
      const clientPort = 50_000 + (pending.user.length * 7 % 10_000);
      const xshell = new CrossVendorRemoteShell({
        device: pending.device,
        user: pending.user,
        remoteHost: pending.host,
        primaryKind,
        sshConnection: `${clientIp} ${clientPort} ${serverIp} ${pending.port}`,
        sshClient: `${clientIp} ${clientPort} ${pending.port}`,
      });
      activeShell = new ShellSubShellAdapter(xshell);
    } else {
      // Vendor without a new-layer Shell yet — fall back to the legacy
      // RemoteDeviceSubShell with the vendor prompt strategy.
      const strategy = this.pickRemoteStrategy(pending.device);
      activeShell = new RemoteDeviceSubShell(
        pending.device, pending.user, pending.host, strategy,
      );
    }

    if (this.activeSubShell) this.subShellStack.push(this.activeSubShell);
    this.activeSubShell = activeShell;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    this.pendingSshPush = null;
    this.sshPasswordAttempts = 0;
    this.inputMode = { type: 'normal' };
    this.notify();
  }

  /**
   * Validate <user, password> against whatever credential store the
   * remote vendor exposes. Linux + Windows machines ship a direct
   * `checkPassword`; routers route through the SSH host's AAA
   * evaluator. Devices that expose neither (synthetic test doubles)
   * accept the credentials so legacy tests don't break.
   */
  private verifyRemoteCredentials(
    device: Equipment, user: string, password: string,
  ): boolean {
    const dev = device as unknown as {
      checkPassword?: (u: string, p: string) => boolean;
      userMgr?: { checkPassword?: (u: string, p: string) => boolean };
      getSshHost?: () => {
        evaluate?: (req: unknown) => { outcome: string };
      };
      firstConfiguredIp?: () => string | null;
    };
    if (typeof dev.checkPassword === 'function') {
      return dev.checkPassword(user, password);
    }
    if (typeof dev.userMgr?.checkPassword === 'function') {
      return dev.userMgr.checkPassword(user, password);
    }
    // Router / Switch path — route through the SSH host's evaluator,
    // which checks the local-user database AND the VTY's protocol
    // gates (transport input, stelnet server enable, …).
    if (typeof dev.getSshHost === 'function') {
      try {
        const localDev = this.device as unknown as { getHostname(): string };
        const req = SshConnectionRequest.create({
          requestedUser: user,
          requestedHost: this.pendingSshPush?.host ?? '',
          requestedPort: this.pendingSshPush?.port ?? 22,
          sourceIp: this.firstLocalIp() ?? '0.0.0.0',
          sourceHostname: localDev.getHostname(),
          command: null,
          offeredAuthMethods: ['password'],
          credentials: { password },
        });
        const decision = dev.getSshHost()?.evaluate?.(req);
        return decision?.outcome === 'accepted';
      } catch {
        return false;
      }
    }
    return true;
  }

  /**
   * Pick the kind of primary shell for the remote's vendor — the shell
   * the user would land in if they were seated at the remote's console.
   */
  private writeKnownHostsEntry(remote: Equipment, host: string, user: string): void {
    const localDev = this.device as unknown as {
      fs?: {
        readFile: (p: string) => { ok: boolean; content?: string };
        createFile: (p: string, c: string) => { ok: boolean; error?: string };
        exists: (p: string) => boolean;
        mkdirp: (p: string) => void;
      };
    };
    if (!localDev.fs) return;
    const remoteAny = remote as unknown as {
      getSshHostKey?: () => { type: string; publicKey: string };
    };
    const hk = remoteAny.getSshHostKey?.();
    if (!hk) return;
    const path = `C:\\Users\\${user}\\.ssh\\known_hosts`;
    const dir = path.substring(0, path.lastIndexOf('\\'));
    if (!localDev.fs.exists(dir)) localDev.fs.mkdirp(dir);
    const existing = localDev.fs.readFile(path);
    const body = existing.ok ? (existing.content ?? '') : '';
    const file = SshKnownHostsFile.parse(body);
    if (!file.find(host)) {
      const updated = file.add({ hostnames: [host], keyType: hk.type, publicKey: hk.publicKey });
      localDev.fs.createFile(path, updated.serialize());
    }
  }

  private pickPrimaryShellKind(eq: Equipment): string {
    return primaryShellKindFor(eq);
  }

  // ── Sub-shell management ───────────────────────────────────────

  private enterPowerShell(): void {
    // Build a real `WindowsPowerShellShell` through the new shell layer
    // and wrap it in the adapter so it plugs into the existing sub-shell
    // stack mechanics (history, completion, special keys). The per-
    // terminal `WindowsShellSession` travels via `extras` so cwd / env
    // isolation between sibling terminals is preserved.
    installDefaultShells();
    const shell = ShellFactory.create('powershell', {
      device: this.device,
      user: 'User',
      cwd: this.shell?.cwd,
      extras: { windowsSession: this.shell },
    });
    shell.setInputHost?.(this.getInputHost());
    const adapter = new ShellSubShellAdapter(shell);

    if (this.activeSubShell) this.subShellStack.push(this.activeSubShell);
    this.activeSubShell = adapter;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;

    for (const line of shell.getActivationBanner()) {
      this.lines.push({ id: nextLineId(), text: line, type: 'ps-header' });
    }
    shell.activate();
    this._onShellModeChange?.('powershell');
    this.notify();
  }

  private enterNestedCmd(): void {
    // Same migration shape as enterPowerShell — the cmd sub-shell comes
    // through the factory now, so the rest of the system never imports
    // the concrete `CmdSubShell` class.
    installDefaultShells();
    const shell = ShellFactory.create('cmd', {
      device: this.device,
      user: 'User',
      cwd: this.shell?.cwd,
      extras: { windowsSession: this.shell },
    });
    shell.setInputHost?.(this.getInputHost());
    const adapter = new ShellSubShellAdapter(shell);

    if (this.activeSubShell) this.subShellStack.push(this.activeSubShell);
    this.activeSubShell = adapter;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;

    for (const line of shell.getActivationBanner()) this.addLine(line);
    shell.activate();
    this._onShellModeChange?.('cmd');
    this.notify();
  }

  /**
   * Forward an out-of-band value (password / text) collected by the host
   * to the active sub-shell's `handleInput`. Mirrors the apply logic of
   * `processLine` so a successful auth pushes the child cleanly.
   */
  private async feedSubShellInput(value: string): Promise<void> {
    if (!this.activeSubShell || typeof this.activeSubShell.handleInput !== 'function') {
      this.notify();
      return;
    }
    const result = await this.activeSubShell.handleInput(value);
    if (result.clearScreen) { this.lines = []; this.bannerCleared = true; }
    if (result.styledOutput && result.styledOutput.length > 0) {
      for (const styled of result.styledOutput) this.addStyledLine(styled.segments, styled.lineType);
    } else if (result.output.length > 0) {
      this.emitWindowsOutput(result.output.join('\n'));
    }
    if (result.exit) { this.exitSubShell(); return; }
    if (result.childShell) { this.pushChildShell(result.childShell); return; }
    if (result.pendingInput) {
      this.subShellPendingInput = result.pendingInput;
      if (result.pendingInput.kind === 'password') {
        this.inputMode = { type: 'password', promptText: result.pendingInput.promptText };
        this._passwordBuf = '';
      } else {
        this.inputMode = { type: 'interactive-text', promptText: result.pendingInput.promptText };
        this._inputBuf = '';
      }
    }
    this.notify();
  }

  private pushChildShell(child: IShell): void {
    child.setInputHost?.(this.getInputHost());
    const adapter = new ShellSubShellAdapter(child);
    if (this.activeSubShell) this.subShellStack.push(this.activeSubShell);
    this.activeSubShell = adapter;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    for (const line of child.getActivationBanner()) this.addLine(line);
    child.activate();
    if (child.kind === 'powershell') this._onShellModeChange?.('powershell');
    else if (child.kind === 'cmd') this._onShellModeChange?.('cmd');
    this.notify();
  }

  private exitSubShell(): void {
    if (this.activeSubShell) {
      this.activeSubShell.dispose();
    }

    // Pop the parent sub-shell from the stack
    if (this.subShellStack.length > 0) {
      this.activeSubShell = this.subShellStack.pop()!;
    } else {
      this.activeSubShell = null;
    }

    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    this.subShellSavedInput = '';

    this._onShellModeChange?.(this.shellMode);
    this.notify();
  }

  /**
   * Generic sub-shell key handler.
   * Works for PowerShell and nested cmd sub-shells.
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

      const applyResult = (result: SubShellResult & { _enterPowerShell?: boolean; _enterCmd?: boolean; childShell?: IShell }) => {
        if (result.clearScreen) {
          this.lines = [];
          this.bannerCleared = true;
        }

        // Prefer pre-styled output when the sub-shell provided it — that
        // way the host's vendor renderer never touches lines whose styling
        // was decided remotely (e.g. SSH'd bash's ANSI colors).
        if (result.styledOutput && result.styledOutput.length > 0) {
          for (const styled of result.styledOutput) {
            this.addStyledLine(styled.segments, styled.lineType);
          }
        } else if (result.output.length > 0) {
          this.emitWindowsOutput(result.output.join('\n'));
        }

        if (result.exit) {
          this.exitSubShell();
          return;
        }

        if (result.childShell) {
          this.pushChildShell(result.childShell);
          return;
        }

        if (result._enterPowerShell) {
          this.enterPowerShell();
          return;
        }
        if (result._enterCmd) {
          this.enterNestedCmd();
          return;
        }

        // Sub-shell asked for a pending input value (typically a nested
        // ssh password). Route the host into the matching input mode;
        // when Enter fires, handleSubShellPendingInput consumes the
        // collected value via shell.handleInput.
        if (result.pendingInput) {
          this.subShellPendingInput = result.pendingInput;
          if (result.pendingInput.kind === 'password') {
            this.inputMode = { type: 'password', promptText: result.pendingInput.promptText };
            this._passwordBuf = '';
          } else {
            this.inputMode = { type: 'interactive-text', promptText: result.pendingInput.promptText };
            this._inputBuf = '';
          }
          this.notify();
          return;
        }

        this.notify();
      };

      if (maybePromise instanceof Promise) {
        maybePromise.then(applyResult);
      } else {
        applyResult(maybePromise as SubShellResult & { _enterPowerShell?: boolean; _enterCmd?: boolean });
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

    // Escape → clear input
    if (e.key === 'Escape') {
      this._inputBuf = '';
      this.tabSuggestions = null;
      this.notify();
      return true;
    }

    // Ctrl+C → cancel current input
    if (e.key === 'c' && e.ctrlKey) {
      this._inputBuf = '';
      this.subShellHistoryIndex = -1;
      this.addLine(`${this.activeSubShell.getPrompt()}^C`);
      this.notify();
      return true;
    }

    // Ctrl+L → clear screen
    if (e.key === 'l' && e.ctrlKey) {
      this.lines = [];
      this.bannerCleared = true;
      this.notify();
      return true;
    }

    // Tab completion in sub-shell (Shift+Tab cycles backwards, like PS).
    if (e.key === 'Tab') {
      this.onSubShellTab(e.shiftKey);
      return true;
    }

    // Any non-Tab key ends a completion cycle and clears the suggestions.
    if (this.tabSuggestions || this.completion) {
      this.tabSuggestions = null;
      this.completion = null;
      this.notify();
    }

    // Let the view handle other keys (typing into the interactive-text input)
    return false;
  }

  // ── Tab completion ──────────────────────────────────────────────

  private onSubShellTab(reverse: boolean = false): void {
    const sub = this.activeSubShell;

    // Sub-shells that own their completion logic (PowerShell) get the
    // real PS console experience: Tab inserts the first match, repeated
    // Tab cycles forward, Shift+Tab cycles backward.
    if (sub && typeof sub.getCompletions === 'function') {
      // Continuing an existing cycle? (Tab pressed again with no edits.)
      if (this.completion && this.completion.applied === this._inputBuf
          && this.completion.candidates.length > 1) {
        const n = this.completion.candidates.length;
        this.completion.index =
          (this.completion.index + (reverse ? -1 : 1) + n) % n;
        const next = this.completion.candidates[this.completion.index];
        this._inputBuf = this.completion.prefix + next;
        this.completion.applied = this._inputBuf;
        this.tabSuggestions = this.completion.candidates.length > 1
          ? this.completion.candidates : null;
        this.notify();
        return;
      }

      // Fresh completion.
      const candidates = sub.getCompletions(this._inputBuf);
      if (candidates.length === 0) { this.completion = null; return; }

      // The token we replace is the trailing run of non-whitespace
      // (matches how PowerShellSubShell.getCompletions tokenizes).
      const m = /(\S*)$/.exec(this._inputBuf);
      const prefix = this._inputBuf.slice(0, this._inputBuf.length - (m ? m[1].length : 0));

      const first = reverse ? candidates[candidates.length - 1] : candidates[0];
      this._inputBuf = prefix + first;
      this.completion = {
        candidates,
        index: reverse ? candidates.length - 1 : 0,
        prefix,
        applied: this._inputBuf,
      };
      this.tabSuggestions = candidates.length > 1 ? candidates : null;
      this.notify();
      return;
    }

    // Fall back to device completions for sub-shells without their own.
    const completions = this.device.getCompletions(this._inputBuf);
    if (completions.length === 0) return;

    const result = completeInputCaseInsensitive(this._inputBuf, completions);
    this._inputBuf = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }

  protected onTab(): void {
    // Root cmd tab completion runs in the per-session context so path
    // completion uses *this* terminal's cwd, not the device-wide shared one
    // (terminal_gap.md §6).
    const dev = this.device;
    const completions = (this.shell && dev instanceof WindowsPC)
      ? dev.getCompletionsForSession(this.input, this.shell)
      : this.device.getCompletions(this.input);
    if (completions.length === 0) return;

    const result = completeInputCaseInsensitive(this.input, completions);
    this.input = result.input;
    this.tabSuggestions = result.suggestions;
    this.notify();
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private isLocalWinShellOutput(): boolean {
    const sub = this.activeSubShell;
    if (!sub) return true;
    return sub instanceof ShellSubShellAdapter
      && (sub.inner.kind === 'powershell' || sub.inner.kind === 'cmd');
  }

  private emitWindowsOutput(text: string): void {
    const rows = this.isLocalWinShellOutput()
      ? classifyWindowsLines(text)
      : text.split('\n').map(t => ({ text: t, type: 'output' as const }));
    for (const r of rows) this.lines.push({ id: nextLineId(), text: r.text, type: r.type });
    this.notify();
  }
}

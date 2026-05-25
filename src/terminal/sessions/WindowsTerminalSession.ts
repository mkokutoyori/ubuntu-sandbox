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
import {
  TerminalSession, TerminalTheme, SessionType, KeyEvent, nextLineId,
  withTimeout, DeviceOfflineError,
  type InputMode,
} from './TerminalSession';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { PlainOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import { completeInputCaseInsensitive } from '@/terminal/core/TabCompletionHelper';
import type { ISubShell, SubShellResult } from '@/terminal/subshells/ISubShell';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { CmdSubShell } from '@/terminal/subshells/CmdSubShell';
import {
  RemoteDeviceSubShell,
  LinuxPromptStrategy,
  CiscoPromptStrategy,
  HuaweiPromptStrategy,
  WindowsPromptStrategy,
  type RemotePromptStrategy,
} from '@/terminal/subshells/RemoteDeviceSubShell';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';

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
    if (this.activeSubShell instanceof PowerShellSubShell) return 'powershell';
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

  override get currentInputMode(): InputMode {
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
    const prompt = this.getPrompt();

    this.addLine(`${prompt}${cmd}`, 'prompt');

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
        this.addMultiLine(result);
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
  ): { user: string | null; host: string; port: number } | null {
    const parts = line.split(/\s+/).filter(p => p.length > 0);
    if (parts[0] !== 'ssh' || parts.length < 2) return null;
    const valueFlags = new Set([
      '-p', '-i', '-l', '-o', '-L', '-R', '-D', '-F', '-J',
      '-c', '-m', '-b', '-E', '-S', '-W', '-w',
    ]);
    let i = 1;
    let port = 22;
    let loginUser: string | null = null;
    while (i < parts.length && parts[i].startsWith('-')) {
      const flag = parts[i];
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
    if (remoteCmd) return null; // exec mode — let device cmdSsh handle it.

    const m = /^(?:([\w.\-\\]+)@)?([\w.-]+)$/.exec(target);
    if (!m) return null;
    return { user: m[1] ?? loginUser, host: m[2], port };
  }

  /**
   * Pick the interactive prompt strategy from the remote device's class
   * name — the same dispatch the Linux session uses, kept in sync so a
   * Cisco IOS peer always gets `Router#` regardless of the client side.
   */
  private pickRemoteStrategy(eq: { constructor: { name: string } }): RemotePromptStrategy {
    const n = eq.constructor.name;
    if (n === 'CiscoRouter' || n === 'CiscoSwitch') return CiscoPromptStrategy;
    if (n === 'HuaweiRouter' || n === 'HuaweiSwitch') return HuaweiPromptStrategy;
    if (n === 'WindowsPC') return WindowsPromptStrategy;
    return LinuxPromptStrategy;
  }

  /** First configured IPv4 on the local Windows machine, or null. */
  private firstLocalIp(): string | null {
    for (const port of this.device.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && port.getIsUp()) return ip.toString();
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

    remote.recordSshLogin?.(user, sourceIp, dev.getHostname(), true);

    // Banner: each remote vendor decides what to print on connect.
    const banner = remote.sshBanner?.() ?? '';
    for (const bannerLine of banner.replace(/\n+$/, '').split('\n')) {
      if (bannerLine.length > 0) this.addLine(bannerLine);
    }

    // Push the interactive sub-shell. The strategy makes the prompt and
    // the exit-words match the vendor, so `quit` on Huawei and `exit` on
    // Linux/Cisco/Windows both pop the stack cleanly.
    const strategy = this.pickRemoteStrategy(found.device);
    const onExit = (): void => {
      // The "Connection to <host> closed." line is emitted by the
      // RemoteDeviceSubShell on exit; nothing else to clean up here for
      // the simulator's in-process SSH transport.
    };
    if (this.activeSubShell) this.subShellStack.push(this.activeSubShell);
    this.activeSubShell = new RemoteDeviceSubShell(
      found.device, user, host, strategy, onExit,
    );
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;
    return true;
  }

  // ── Sub-shell management ───────────────────────────────────────

  private enterPowerShell(): void {
    // Seed the PS sub-shell with THIS terminal's cwd so opening PowerShell
    // from terminal A doesn't pick up terminal B's `cd D:\foo`
    // (terminal_gap.md §7.5).
    const { subShell, banner } = PowerShellSubShell.create(this.device, {
      initialCwd: this.shell?.cwd,
      session: this.shell,
    });
    // If there's already an active subshell, push it onto the stack
    if (this.activeSubShell) {
      this.subShellStack.push(this.activeSubShell);
    }
    this.activeSubShell = subShell;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;

    for (const line of banner) {
      this.lines.push({ id: nextLineId(), text: line, type: 'ps-header' });
    }
    this._onShellModeChange?.('powershell');
    this.notify();
  }

  private enterNestedCmd(): void {
    const { subShell, banner } = CmdSubShell.create(this.device);
    // Push current subshell (PowerShell) onto the stack
    if (this.activeSubShell) {
      this.subShellStack.push(this.activeSubShell);
    }
    this.activeSubShell = subShell;
    this.subShellHistory = [];
    this.subShellHistoryIndex = -1;

    for (const line of banner) {
      this.addLine(line);
    }
    this._onShellModeChange?.('cmd');
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
      this.addLine(`${this.activeSubShell.getPrompt()}${line}`);

      // Push non-empty lines to sub-shell history
      if (line.trim()) {
        this.subShellHistory = [...this.subShellHistory.slice(-199), line];
      }

      const maybePromise = this.activeSubShell.processLine(line);

      const applyResult = (result: SubShellResult & { _enterPowerShell?: boolean; _enterCmd?: boolean }) => {
        if (result.clearScreen) {
          this.lines = [];
          this.bannerCleared = true;
        }

        for (const outputLine of result.output) this.addLine(outputLine);

        if (result.exit) {
          this.exitSubShell();
          return;
        }

        // Handle nested shell transitions
        if (result._enterPowerShell) {
          this.enterPowerShell();
          return;
        }
        if (result._enterCmd) {
          this.enterNestedCmd();
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

  private addMultiLine(text: string, type: string = 'normal'): void {
    const lines = text.split('\n');
    for (const line of lines) {
      this.lines.push({ id: nextLineId(), text: line, type });
    }
    this.notify();
  }
}

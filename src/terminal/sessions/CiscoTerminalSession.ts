/**
 * CiscoTerminalSession — Cisco IOS terminal model.
 *
 * Defines which Cisco IOS commands require interactive prompts
 * (enable password, reload confirmation, copy confirmations, etc.)
 * via buildInteractiveFlow() → InteractiveFlowEngine.
 */

import type { ICLIDevice } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType, withTimeout, DeviceOfflineError } from './TerminalSession';
import type { InteractiveStep } from '@/terminal/core/types';
import { Router } from '@/network/devices/Router';
import { Switch } from '@/network/devices/Switch';
import { IPAddress } from '@/network/core/types';
import { parsePingArgs, formatCiscoPingSummary, type CiscoPingRow } from '@/network/devices/shells/cisco/ciscoPing';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import type { AsyncJobHandle } from '@/terminal/async';
import type { TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';
import type { LoggingMonitorSource } from '@/network/devices/inspection/config/LoggingConfig';

const CISCO_THEME: TerminalTheme = {
  sessionType: 'cisco',
  backgroundColor: '#000000',
  textColor: '#4ade80',     // green-400
  errorColor: '#f87171',    // red-400
  promptColor: '#4ade80',
  fontFamily: "monospace",
  infoBarBg: 'rgba(0,0,0,0.5)',
  infoBarText: '#16a34a',   // green-600
  infoBarBorder: 'rgba(22,101,52,0.5)',
  bootColor: '#22c55e',     // green-500
  pagerColor: '#facc15',    // yellow-400
};

export class CiscoTerminalSession extends CLITerminalSession {
  /**
   * Per-terminal vty session — allocated when the underlying device is a
   * Router. Holds the mode (user/priv/config/...), the selectedInterface
   * and every other sub-mode pointer that real Cisco IOS keeps per vty.
   *
   * See terminal_gap.md §5.1.
   */
  vty: CliShellSession | null = null;

  constructor(id: string, device: ICLIDevice) {
    super(id, device);
    if (device instanceof Router || device instanceof Switch) {
      this.vty = device.openVtySession();
      this.registerTearDown(() => {
        const s = this.vty;
        if (s && (device instanceof Router || device instanceof Switch)) device.closeVtySession(s);
        this.vty = null;
      });
    }
  }

  getSessionType(): SessionType { return 'cisco'; }
  getTheme(): TerminalTheme { return CISCO_THEME; }

  /**
   * Real Cisco console login gate: when `line console 0` is configured
   * with `login local`, every new console connection (this terminal
   * window opening = plugging into the physical console) must
   * authenticate before reaching a command prompt — "User Access
   * Verification" / "Username:" / "Password:", 3 failed attempts closes
   * the line. A factory-default device (no `line console 0 / login`
   * configured at all) skips this entirely, preserving the existing
   * "double-click opens straight to a prompt" behaviour every other test
   * in the suite already depends on.
   */
  override async init(): Promise<void> {
    await super.init();
    this.maybeStartConsoleLogin();
  }

  private maybeStartConsoleLogin(): void {
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => { login: 'password' | 'local' | 'none' | null } | null;
    } | undefined)?._getConsoleLineConfig?.();
    // Scope: `login local` (multi-account Username:/Password:) only — a
    // bare `login` (single shared line password, no username prompt) is a
    // real, distinct IOS mode not exercised by this scenario; left as a
    // disclosed gap rather than faked.
    if (!cfg || cfg.login !== 'local') return;
    this.startFlowFromSteps(this.buildConsoleLoginSteps(), '');
  }

  private deviceBanner(kind: 'motd' | 'login' | 'exec' | 'incoming'): string {
    const dev = this.device as unknown as { getBanner?: (k: string) => string };
    return dev.getBanner?.(kind) ?? '';
  }

  private verifyConsoleLogin(username: string, password: string): boolean {
    const dev = this.device as unknown as {
      getCredentialStore?: () => { authenticate: (u: string, p: string) => boolean };
    };
    return dev.getCredentialStore?.().authenticate(username, password) ?? false;
  }

  private lookupAccountPrivilege(username: string): number {
    const dev = this.device as unknown as {
      getCredentialStore?: () => { get: (u: string) => { privilege: number } | undefined };
    };
    return dev.getCredentialStore?.().get(username)?.privilege ?? 1;
  }

  /**
   * "User Access Verification" console login, real IOS semantics: prompt
   * Username: then Password:, `% Login invalid` on any mismatch (no
   * distinction between "no such user" and "wrong password" — a security
   * property, not an oversight) looping back to Username: up to 3 times,
   * then `% Bad passwords` and the line closes. Built with the richer
   * text/password/branch/execute step vocabulary (not the vendor-neutral
   * CommandInteractionPlan) because the retry loop needs real branching —
   * mirrors the existing outbound-SSH interactive flow's construction.
   */
  private buildConsoleLoginSteps(): InteractiveStep[] {
    // Real IOS order: `banner login` is shown right before the login
    // prompt (unlike `banner motd`, already shown earlier in `init()`,
    // before this flow even starts).
    const loginBanner = this.deviceBanner('login');
    const preLines = loginBanner.length > 0 ? [...loginBanner.split('\n'), ''] : [];
    return [
      /* 0 */ { type: 'output', outputLines: [...preLines, 'User Access Verification', ''] },
      /* 1 */ { type: 'text', prompt: 'Username: ', allowEmpty: true, storeAs: 'console_login_username' },
      /* 2 */ {
        type: 'password',
        prompt: 'Password: ',
        mask: 'hidden',
        storeAs: 'console_login_password',
        validation: (pwd, ctx) => {
          const username = (ctx.values.get('console_login_username') ?? '').trim();
          const ok = this.verifyConsoleLogin(username, pwd);
          const attempts = parseInt(ctx.values.get('console_login_attempts') ?? '0', 10) + (ok ? 0 : 1);
          ctx.values.set('console_login_attempts', String(attempts));
          ctx.values.set('console_login_ok', ok ? '1' : '0');
          if (ok) ctx.values.set('console_login_account', username);
          // Always advance -- looping/closing is driven explicitly by the
          // branch step below, not the engine's own retry mechanism.
          return { valid: true };
        },
      },
      /* 3 */ {
        type: 'branch',
        // On success, skip straight to the success handler. On ANY
        // failure -- including the 3rd -- always show "% Login invalid"
        // first (step 9); step 10 then decides whether to loop back to
        // Username: or escalate to "% Bad passwords".
        predicate: (ctx) => (ctx.values.get('console_login_ok') === '1' ? 4 : 9),
      },
      /* 4 */ {
        type: 'execute',
        action: async (ctx) => {
          const username = ctx.values.get('console_login_account') ?? '';
          // Real IOS: a `privilege level N` configured on the line
          // OVERRIDES the authenticated user's own account privilege
          // (confirmed behaviour, not just a "default when unset") --
          // only fall back to the account's privilege when the line
          // itself has no override configured.
          const linePrivilege = this.consoleLinePrivilegeOverride();
          const privilege = linePrivilege ?? this.lookupAccountPrivilege(username);
          if (this.vty) {
            this.vty.state.mode = privilege === 15 ? 'privileged' : 'user';
            this.vty.state.privilegeLevel = privilege;
          }
          this.rearmExecTimeout();
          // Real IOS: `banner exec` is shown after a SUCCESSFUL login only,
          // right before the command prompt -- never on a failed attempt.
          const execBanner = this.deviceBanner('exec');
          if (execBanner) for (const ln of execBanner.split('\n')) this.addLine(ln);
        },
      },
      /* 5 */ { type: 'branch', predicate: () => 11 },
      /* 6 */ { type: 'output', outputLines: ['% Bad passwords'] },
      /* 7 */ { type: 'execute', action: async () => { this._onRequestClose?.(); } },
      /* 8 */ { type: 'branch', predicate: () => 11 },
      /* 9 */ { type: 'output', outputLines: ['% Login invalid'] },
      /* 10 */ {
        type: 'branch',
        predicate: (ctx) => {
          const attempts = parseInt(ctx.values.get('console_login_attempts') ?? '0', 10);
          return attempts >= 3 ? 6 : 1;
        },
      },
      // Steps 5 and 8 branch to index 11 == steps.length, ending the flow
      // immediately (InteractiveFlowEngine.isComplete is currentIndex >=
      // steps.length) without an extra no-op step.
    ];
  }

  // `banner <kind> <delim>` multi-line capture is declared by the IOS
  // shell itself (CiscoShellBase.bannerCaptureInteractionPlan, a `collect`
  // step) — the generic planner-driven buildInteractiveFlow renders it
  // here, and the SSH adapters render the SAME plan. Nothing banner-
  // specific remains in the terminal layer.

  // Set by `prepareAsRemoteUser` -- `this.isRemoteChild` (`_parent !==
  // null`) is NOT yet true at that point (`adoptRemoteChild` calls
  // `prepareAsRemoteUser` BEFORE `attachAsChildOf`), so exec-timeout
  // resolution needs its own explicit "this is a VTY line, not the
  // console" flag rather than relying on parent-attachment timing.
  private isVtyRemoteSession = false;

  protected override prepareAsRemoteUser(user: string): void {
    this.isVtyRemoteSession = true;
    if (this.vty) {
      // Real IOS: a `privilege level N` configured on the VTY line
      // OVERRIDES the authenticated user's own account privilege (same
      // rule as the console line above) -- confirmed via Cisco's own
      // documentation, not just a default-when-unset fallback.
      const linePrivilege = this.vtyLinePrivilegeOverride();
      const privilege = linePrivilege ?? this.lookupAccountPrivilege(user);
      this.vty.state.mode = privilege === 15 ? 'privileged' : 'user';
      this.vty.state.privilegeLevel = privilege;
    }
    this.isBooting = false;
    this.updatePrompt();
    this.rearmExecTimeout();
  }

  /** `privilege level N` configured on `line console 0`, if any. */
  private consoleLinePrivilegeOverride(): number | null {
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => { privilegeLevel: number | null } | null;
    } | undefined)?._getConsoleLineConfig?.();
    return cfg?.privilegeLevel ?? null;
  }

  /**
   * `privilege level N` configured on the (first) `line vty …` block, if
   * any. The simulator does not track which specific VTY slot number an
   * incoming session occupies, so — matching the common single-block
   * configuration this scenario (and real small deployments) uses — the
   * first configured VTY block's privilege applies.
   */
  private vtyLinePrivilegeOverride(): number | null {
    const dev = this.device as unknown as {
      _getVtyLineConfig?: () => { all: () => ReadonlyArray<{ privilege: number | null }> };
    };
    const block = dev._getVtyLineConfig?.().all()[0];
    return block?.privilege ?? null;
  }

  // ── exec-timeout (idle disconnect) ──────────────────────────────────

  protected override onCommandActivity(): void {
    this.rearmExecTimeout();
  }

  /** Effective exec-timeout, in milliseconds, for the line this session represents. */
  private resolveExecTimeoutMs(): number | null {
    if (this.isVtyRemoteSession) {
      const dev = this.device as unknown as {
        _getVtyLineConfig?: () => { all: () => ReadonlyArray<{ execTimeoutMinutes: number | null; execTimeoutSeconds: number | null }> };
      };
      const block = dev._getVtyLineConfig?.().all()[0];
      if (!block || (block.execTimeoutMinutes == null && block.execTimeoutSeconds == null)) return null;
      return ((block.execTimeoutMinutes ?? 0) * 60 + (block.execTimeoutSeconds ?? 0)) * 1000;
    }
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => { execTimeoutMin: number | null; execTimeoutSec: number } | null;
    } | undefined)?._getConsoleLineConfig?.();
    if (!cfg || cfg.execTimeoutMin == null) return null;
    return (cfg.execTimeoutMin * 60 + cfg.execTimeoutSec) * 1000;
  }

  private rearmExecTimeout(): void {
    const ms = this.resolveExecTimeoutMs();
    if (ms == null) { this.clearIdleTimer(); return; }
    this.armIdleTimer(ms, () => this.onExecTimeout());
  }

  private onExecTimeout(): void {
    if (this.disposed) return;
    if (this.isRemoteChild) {
      // VTY: the line drops -- the local (client) session sees the same
      // "Connection to X closed." footer any other SSH teardown produces.
      this.endRemoteSession();
      return;
    }
    // Console: the EXEC session times out and resets to an unauthenticated
    // line -- if `login local` is configured, the login banner reappears;
    // otherwise this is a silent no-op (matches real IOS: exec-timeout on
    // a line with no login configured just resets an idle session with
    // nothing to reauthenticate).
    if (this.vty) {
      this.vty.state.mode = 'user';
      this.vty.state.privilegeLevel = 1;
    }
    this.updatePrompt();
    this.addLine(this.prompt);
    this.maybeStartConsoleLogin();
  }

  /**
   * Run commands through the per-vty queue so the shared shell is swapped
   * into this session's state for the duration of the call. Concurrent
   * terminals on the same router thus observe their own mode without
   * stepping on each other's privilege level (terminal_gap.md §5.1).
   */
  protected override async executeOnDevice(
    command: string,
    timeoutMs?: number,
  ): Promise<string> {
    const dev = this.device;
    if (!dev.getIsPoweredOn()) throw new DeviceOfflineError(dev.getName());
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      const p = dev.executeCommandInVty(command, this.vty);
      return timeoutMs != null ? withTimeout(p, timeoutMs) : p;
    }
    return super.executeOnDevice(command, timeoutMs);
  }

  /**
   * Effective `terminal length` of this vty session.
   * Real Cisco IOS scopes this preference per line — `terminal length 0`
   * disables the pager for the current session only (terminal_gap.md §5.3).
   */
  protected override getPageSize(): number {
    return this.vty?.state.terminalLength ?? 24;
  }

  protected override resolveCliHelp(currentInput: string): string {
    const dev = this.device;
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      return dev.cliHelpForVty(currentInput, this.vty);
    }
    return super.resolveCliHelp(currentInput);
  }

  protected override resolveCliTabCandidates(input: string): string[] {
    const dev = this.device;
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      return dev.cliTabCandidatesForVty(input, this.vty);
    }
    return super.resolveCliTabCandidates(input);
  }

  /**
   * Override updatePrompt to read the prompt from the vty's swapped-in
   * shell state, not from the device's shared default state.
   */
  override updatePrompt(): void {
    const dev = this.device;
    if (this.vty && (dev instanceof Router || dev instanceof Switch)) {
      this.prompt = dev.getPromptForVty(this.vty);
    } else {
      this.prompt = this.cliDevice.getPrompt();
    }
    this.notify();
  }

  protected getDefaultPrompt(): string {
    return `${this.device.getHostname()}>`;
  }

  protected getCtrlZCommand(): string { return 'end'; }
  protected getPagerIndicator(): string { return ' --More-- '; }

  protected isTopLevelExit(line: string): boolean {
    const w = line.trim().toLowerCase();
    if (w === 'logout') return true;
    if (w !== 'exit' && w !== 'quit') return false;
    const mode = this.vty?.state.mode;
    return mode === 'user' || mode === 'privileged';
  }

  getInfoBarContent() {
    const deviceType = this.device.getType();
    const isSwitch = deviceType.includes('switch');
    return {
      left: `${this.device.getHostname()} — ${isSwitch ? 'C2960 Switch' : 'C2911 Router'}`,
      right: '? = help | Tab = complete',
    };
  }

  protected getFallbackBootLines(): string[] {
    return []; // Cisco devices should always provide getBootSequence()
  }

  /**
   * `logging synchronous` on the console line: while the operator has an
   * unsubmitted command in progress, async output (syslog/monitor/debug)
   * is deferred instead of visually interrupting the in-progress line —
   * flushed once the command is submitted (`CLITerminalSession.
   * executeCommand` calls `flushDeferredAsyncQueue()` right before
   * echoing it). Without `logging synchronous` (real IOS default),
   * nothing is deferred — async lines interrupt immediately.
   */
  protected override shouldDeferAsyncOutput(): boolean {
    if (this.isRemoteChild) return false; // scoped to the console line for now
    if (this.input.length === 0) return false;
    const shell = (this.device as unknown as { getShell?: () => unknown }).getShell?.();
    const cfg = (shell as {
      _getConsoleLineConfig?: () => { loggingSynchronous: boolean } | null;
    } | undefined)?._getConsoleLineConfig?.();
    return cfg?.loggingSynchronous ?? false;
  }

  /**
   * Interactive commands (copy/reload/erase) are declared by the IOS shell
   * itself (CiscoShellBase.interactionPlanFor) — the generic planner-driven
   * buildInteractiveFlow in CLITerminalSession renders them. Only the CLI
   * mode is supplied here so plans stay privileged-EXEC-only.
   */
  protected override interactionPlanContext() {
    return { mode: this.vty?.state.mode ?? 'user', device: this.device };
  }

  private debugJob: AsyncJobHandle | null = null;
  private debugUnsubscribe: (() => void) | null = null;
  private monitorJob: AsyncJobHandle | null = null;
  private monitorUnsubscribe: (() => void) | null = null;

  protected override afterCommandExecuted(_command: string): void {
    this.reconcileDebugSubscription();
    this.reconcileTerminalMonitor();
  }

  protected override tryInterceptAsyncCommand(command: string): boolean {
    return this.tryStartCiscoPing(command);
  }

  private tryStartCiscoPing(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const dev = this.device;
    if (!(dev instanceof Router)) return false;
    const mode = this.vty?.state.mode;
    if (mode !== 'user' && mode !== 'privileged') return false;

    const toks = commandLine.trim().split(/\s+/);
    if (toks[0] !== 'ping') return false;
    const parsed = parsePingArgs(toks.slice(1));
    if (parsed.error || parsed.sourceIP) return false;

    const targetIP = new IPAddress(parsed.target);
    const results: CiscoPingRow[] = [];
    let marksBase = this.lines.length;

    const repaintMarks = () => {
      this.lines = this.lines.slice(0, marksBase);
      this.addLine(results.map((r) => (r.success ? '!' : '.')).join(''));
      this.notify();
    };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      label: `ping ${parsed.target}`,
      run: async (ctx) => {
        ctx.sink.line('Type escape sequence to abort.');
        ctx.sink.line(`Sending ${parsed.count}, ${parsed.sizeBytes}-byte ICMP Echos to ${parsed.target}, timeout is ${parsed.timeoutMs / 1000} seconds:`);
        marksBase = this.lines.length;
        this.addLine('');
        this.notify();

        await dev.executePingSequence(targetIP, parsed.count, parsed.timeoutMs, undefined, {
          onResult: (row) => { if (ctx.cancelled()) return; results.push(row); repaintMarks(); },
          shouldStop: () => ctx.cancelled(),
        });
        if (ctx.cancelled()) return;

        if (results.length === 0) {
          this.lines = this.lines.slice(0, marksBase);
          this.addLine('.'.repeat(parsed.count));
          this.notify();
        }
        ctx.sink.line(formatCiscoPingSummary(results, parsed.count));
      },
      onInterrupt: (ctx) => { ctx.sink.line(formatCiscoPingSummary(results, parsed.count)); },
    });
    return job !== null;
  }

  private reconcileDebugSubscription(): void {
    const svc = (this.device as unknown as { getDebugService?: () => TerminalDebugSource }).getDebugService?.();
    if (!svc) return;
    if (svc.hasAnyFlag() && !this.debugJob) {
      this.startDebugSubscription(svc);
    } else if (!svc.hasAnyFlag() && this.debugJob) {
      this.debugJob.cancel();
      this.debugJob = null;
    }
  }

  private reconcileTerminalMonitor(): void {
    const on = this.vty?.state.terminalMonitor ?? false;
    if (!on && !this.monitorJob) return;
    const src = (this.device as unknown as { getLoggingConfig?: () => LoggingMonitorSource | null }).getLoggingConfig?.();
    if (on && src && !this.monitorJob) {
      this.startMonitorSubscription(src);
    } else if ((!on || !src) && this.monitorJob) {
      this.monitorJob.cancel();
      this.monitorJob = null;
    }
  }

  private startMonitorSubscription(src: LoggingMonitorSource): void {
    this.monitorJob = this.startAsyncCommand({
      mode: 'background',
      kind: 'subscription',
      command: 'terminal monitor',
      label: 'syslog monitor',
      run: (ctx) => new Promise<void>((resolve) => {
        if (ctx.cancelled()) { resolve(); return; }
        this.monitorUnsubscribe = src.subscribeMonitor((line) => ctx.sink.line(line));
        ctx.onCancel(() => {
          this.monitorUnsubscribe?.();
          this.monitorUnsubscribe = null;
          resolve();
        });
      }),
    });
  }

  private startDebugSubscription(svc: TerminalDebugSource): void {
    this.debugJob = this.startAsyncCommand({
      mode: 'background',
      kind: 'subscription',
      command: 'debug',
      label: 'IOS debug output',
      run: (ctx) => new Promise<void>((resolve) => {
        if (ctx.cancelled()) { resolve(); return; }
        this.debugUnsubscribe = svc.subscribe((line) => ctx.sink.line(line));
        ctx.onCancel(() => {
          this.debugUnsubscribe?.();
          this.debugUnsubscribe = null;
          resolve();
        });
      }),
    });
  }
}

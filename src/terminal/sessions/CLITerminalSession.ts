/**
 * CLITerminalSession — Abstract base for vendor CLI terminals (Cisco IOS, Huawei VRP).
 *
 * Shared features:
 *   - Boot sequence with line-by-line animation
 *   - --More-- / ---- More ---- pager
 *   - Interactive flows (enable password, reload confirm, save, etc.)
 *   - Inline ? help (intercepted on keypress)
 *   - Tab completion via device.cliTabComplete()
 *   - Ctrl+Z (exit to top-level mode)
 *   - Ctrl+W (delete word backward)
 *   - Ctrl+A/E (cursor movement)
 *   - Dynamic prompt from device.getPrompt()
 */

import type { Equipment, ICLIDevice } from '@/network';
import {
  TerminalSession, TerminalTheme, SessionType,
  KeyEvent, InputMode,
} from './TerminalSession';
import { PlainOutputFormatter, type IOutputFormatter } from '@/terminal/core/OutputFormatter';
import {
  CompletionController, SilentUniquePolicy, FullLineSource, ghostRemainder,
  type CompletionPolicy,
} from '@/terminal/completion';
import type { InteractiveStep } from '@/terminal/core/types';
import { isInteractionPlanner, type InteractionPlanContext } from '@/shell/interaction/CommandInteraction';
import { toInteractiveSteps } from '@/terminal/flows/planAdapter';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { launchTelnet } from '@/terminal/subshells/telnetLaunch';
import type { TelnetInteractiveSubShell } from '@/terminal/subshells/TelnetInteractiveSubShell';
import { createSessionForDevice } from './sessionFactory';
import { SshConnectionRequest } from '@/network/protocols/ssh/server/SshConnectionRequest';

/** Default pager page size — matches Cisco/Huawei `terminal length 24`. */
const DEFAULT_PAGE_SIZE = 24;

/** Sentinel value returned by shells to signal the session should close */
export const CONNECTION_CLOSED = 'Connection closed.';

export abstract class CLITerminalSession extends TerminalSession {
  isBooting: boolean = true;
  prompt: string = '';

  // Pager state
  pagerLines: string[] | null = null;
  pagerOffset: number = 0;

  private readonly _flowFormatter = new PlainOutputFormatter();

  /** Strongly-typed reference to the CLI device (avoids `as any` casts). */
  protected readonly cliDevice: ICLIDevice;

  private _cliCompletion: CompletionController | null = null;

  constructor(id: string, device: ICLIDevice) {
    super(id, device);
    this.cliDevice = device;
  }

  /** Vendor Tab policy — Cisco stays silent on ambiguity; Huawei overrides. */
  protected completionPolicy(): CompletionPolicy {
    return new SilentUniquePolicy();
  }

  protected get cliCompletion(): CompletionController {
    if (this._cliCompletion === null) {
      this._cliCompletion = new CompletionController(this.completionPolicy());
    }
    return this._cliCompletion;
  }

  protected getFlowFormatter(): IOutputFormatter { return this._flowFormatter; }

  // ── Prompt ──────────────────────────────────────────────────────

  updatePrompt(): void {
    this.prompt = this.cliDevice.getPrompt();
    this.notify();
  }

  getPrompt(): string {
    if (this.hasActiveChild) return this.foreground.getPrompt();
    if (this.telnetSubShell) return this.telnetSubShell.getPrompt();
    return this.prompt;
  }

  /**
   * An outbound `telnet` session held open by this terminal. A CLI
   * terminal has no general sub-shell stack — the one case that needs
   * it is telnet, whose remote answers arrive asynchronously off a real
   * socket (docs/PRD-VTY-Transport.md §2.1 item 6).
   */
  private telnetSubShell: TelnetInteractiveSubShell | null = null;

  protected abstract getDefaultPrompt(): string;

  protected abstract isTopLevelExit(line: string): boolean;

  /** The vendor-specific "go to top-level" command (Cisco: 'end', Huawei: 'return') */
  protected abstract getCtrlZCommand(): string;

  /** The pager indicator text */
  protected abstract getPagerIndicator(): string;

  /**
   * Command-owned interactive flows (IoC): the DEVICE SHELL declares which
   * commands are interactive via `interactionPlanFor`; this session merely
   * renders the returned plan. No vendor-specific string matching lives in
   * the terminal layer anymore.
   */
  protected buildInteractiveFlow(command: string): InteractiveStep[] | null {
    const shell = (this.device as { getShell?: () => unknown }).getShell?.();
    if (!isInteractionPlanner(shell)) return null;
    const plan = shell.interactionPlanFor(command, this.interactionPlanContext());
    return plan ? toInteractiveSteps(plan) : null;
  }

  /** Caller-side facts (CLI mode, identity) handed to the planner. */
  protected interactionPlanContext(): InteractionPlanContext {
    return {};
  }

  // ── Input mode ─────────────────────────────────────────────────

  override get currentInputMode(): InputMode {
    if (this.hasActiveChild) return this.foreground.currentInputMode;
    if (this.isFlowActive) {
      return this.inputMode; // set by advanceFlow()
    }
    return this.inputMode;
  }

  // ── Boot sequence ───────────────────────────────────────────────

  async init(): Promise<void> {
    // Real Cisco / Huawei: plugging a console to an already-running router
    // shows just the prompt, not the System Bootstrap banner. We only
    // replay the boot sequence on the FIRST session opened after a power
    // cycle (cf. terminal_gap.md §5.2).
    const alreadyBooted = this.device.hasBootBeenShown();
    if (alreadyBooted) {
      this.isBooting = false;
      this.inputMode = { type: 'normal' };
      // Still surface the MOTD banner — that's per-session on real gear.
      const motd = this.cliDevice.getBanner('motd');
      if (motd) this.addLine(motd);
      this.updatePrompt();
      return;
    }

    this.isBooting = true;
    this.inputMode = { type: 'booting' };
    this.notify();

    const bootText = this.cliDevice.getBootSequence();

    if (bootText) {
      const lines = bootText.split('\n');
      for (const line of lines) {
        await new Promise(r => setTimeout(r, 12));
        this.addLine(line, 'boot');
      }
    } else {
      const fallback = this.getFallbackBootLines();
      for (const line of fallback) {
        await new Promise(r => setTimeout(r, 15));
        this.addLine(line, 'boot');
      }
    }

    // Show MOTD banner if available
    const motd = this.cliDevice.getBanner('motd');
    if (motd) {
      this.addLine('');
      this.addLine(motd);
    }

    this.addLine('');
    this.isBooting = false;
    this.inputMode = { type: 'normal' };
    this.device.markBootShown();
    this.updatePrompt();
  }

  /** Fallback boot lines if device doesn't provide getBootSequence(). */
  protected abstract getFallbackBootLines(): string[];

  // ── Close callback ─────────────────────────────────────────────

  protected _onRequestClose?: () => void;
  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }

  // ── Key handling ────────────────────────────────────────────────

  /**
   * An interactive SSH/Telnet hop (`ssh -l admin 10.0.0.2`, then typing
   * commands on the remote device) attaches a child session via
   * `adoptRemoteChild`, exactly like Linux/Windows do. Those two already
   * route every key to `this.foreground` once a child exists — CLI
   * (Cisco/Huawei) lacked the same override, so keys kept being handled by
   * `this` (the LOCAL session): the visible prompt/banner came from the
   * remote child (`getPrompt()`/`currentInputMode` already delegate), but
   * `onEnter()`/`showInlineHelp()` ran locally, silently applying typed
   * commands — including config changes — to the wrong device. One override
   * here fixes it for both vendors without duplicating per-device logic.
   */
  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;
    if (this.hasActiveChild) return this.foreground.handleKey(e);
    return super.handleKey(e);
  }

  protected handleModeKey(e: KeyEvent): boolean {
    // Pager mode
    if (this.pagerLines) {
      if (e.key === ' ') { this.pagerNextPage(); return true; }
      if (e.key === 'Enter') { this.pagerNextLine(); return true; }
      if (e.key === 'q' || e.key === 'Q' || (e.key === 'c' && e.ctrlKey)) {
        this.pagerQuit();
        return true;
      }
      return true; // consume all keys in pager mode
    }

    // Flow engine active — delegate to base class handlers
    if (this.isFlowActive) {
      if (this.inputMode.type === 'password') return this.handleFlowPasswordKey(e);
      if (this.inputMode.type === 'interactive-text') return this.handleFlowTextKey(e);
    }

    return false;
  }

  protected handleNormalKey(e: KeyEvent): boolean {
    // ? (inline help — intercepted before reaching input)
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      this.showInlineHelp(this.input);
      return true;
    }

    // Ctrl+Z → go to top-level mode
    if (e.key === 'z' && e.ctrlKey) {
      this.addLine(`${this.prompt}${this.input}^Z`);
      this.input = '';
      this.executeOnDevice(this.getCtrlZCommand())
        .then(() => this.updatePrompt())
        .catch((err) => {
          if (err instanceof Error && err.name === 'DeviceOfflineError') {
            // Bus-driven disconnect notice already covers the visible
            // "device offline" trace; suppress this one to avoid stacking.
            if (!this.isDisconnected) {
              this.addLine('% Device is powered off', 'error');
            }
          } else {
            this.addLine(`% Error: ${err}`, 'error');
          }
        });
      this.notify();
      return true;
    }

    // Ctrl+W → delete word backward
    if (e.key === 'w' && e.ctrlKey) {
      const pos = this.input.length;
      let i = pos - 1;
      while (i >= 0 && this.input[i] === ' ') i--;
      while (i >= 0 && this.input[i] !== ' ') i--;
      this.input = this.input.slice(0, i + 1);
      this.notify();
      return true;
    }

    // Ctrl+A/E → cursor (handled by view, but consume)
    if ((e.key === 'a' || e.key === 'e') && e.ctrlKey) return true;

    return super.handleNormalKey(e);
  }

  // ── Command execution ───────────────────────────────────────────

  protected onEnter(): void | Promise<void> {
    const cmd = this.input || this._inputBuf;
    this.input = '';
    this._inputBuf = '';
    this.recordEvent('input', cmd);
    const done = this.executeCommand(cmd);
    this.notify();
    return done;
  }

  private async executeCommand(cmd: string): Promise<void> {
    const trimmed = cmd.trim();
    this.flushDeferredAsyncQueue();
    this.onCommandActivity();
    this.addEchoLine(this.prompt, cmd);

    if (trimmed) {
      this.pushHistory(trimmed);
    }

    if (this.telnetSubShell) {
      await this.runTelnetLine(trimmed);
      return;
    }

    const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();
    if (firstWord === 'telnet') {
      await this.enterTelnet(trimmed.split(/\s+/).slice(1));
      return;
    }
    if (firstWord && this.sshInteractiveVerbs().includes(firstWord) && this.sshInteractiveModeAllowed()) {
      const sshSteps = this.buildSshInteractiveFlowSteps(trimmed);
      if (sshSteps) {
        this.startFlowFromSteps(sshSteps, trimmed);
        return;
      }
    }

    const steps = this.buildInteractiveFlow(trimmed);
    if (steps) {
      this.startFlowFromSteps(steps, trimmed);
      return;
    }

    if (this.tryInterceptAsyncCommand(trimmed)) return;

    const exitBeforeExec = this.isRemoteChild && this.isTopLevelExit(trimmed);

    try {
      const result = await this.executeOnDevice(trimmed);

      if (result === CONNECTION_CLOSED || exitBeforeExec) {
        if (this.endRemoteSession()) return;
        this._onRequestClose?.();
        return;
      }

      if (result) {
        const lines = result.split('\n');
        const pageSize = this.getPageSize();
        if (pageSize > 0 && lines.length > pageSize) {
          this.startPager(lines);
        } else if (pageSize <= 0 && lines.length > DEFAULT_PAGE_SIZE) {
          // Pager disabled — addLines preserves line typing.
          this.addLines(lines);
        } else {
          this.addLine(result);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'DeviceOfflineError') {
        if (!this.isDisconnected) {
          this.addLine('% Device is powered off — session disconnected', 'error');
        }
        return;
      }
      if (err instanceof Error && err.name === 'CommandTimeoutError') {
        this.addLine('% Command execution timed out', 'error');
      } else {
        this.addLine(`% Error: ${err}`, 'error');
      }
    }

    this.updatePrompt();
    this.afterCommandExecuted(trimmed);
  }

  /**
   * Hook fired after a command has fully executed and the prompt has been
   * refreshed. Subclasses use it to reconcile asynchronous side effects of
   * the command (e.g. starting/stopping live debug streams) with the
   * device's post-command state.
   */
  protected afterCommandExecuted(_command: string): void {}

  // ── Outbound SSH interactive push ──────────────────────────────

  /**
   * Verbs the CLI recognises as an outbound SSH client launch. Huawei
   * additionally accepts `stelnet` as a synonym.
   */
  protected sshInteractiveVerbs(): string[] { return ['ssh']; }

  /**
   * Only user/privileged exec mode has an outbound `ssh` client on real
   * IOS/VRP gear; other modes (config, …) fall through to the device's
   * own trie so it reports its usual "invalid input" for the mode.
   */
  protected sshInteractiveModeAllowed(): boolean {
    const mode = (this as unknown as { vty?: { state: { mode: string } } | null }).vty?.state.mode;
    // Huawei's vty starts life in 'user-view' (Router.openVtySession's
    // initialMode) and only gets rewritten to the shell's own 'user'
    // string once the first command has round-tripped through
    // snapshotVtyState/applyVtyState — so a freshly-opened session's
    // very first command must still recognise 'user-view'.
    return mode === undefined || mode === 'user' || mode === 'privileged' || mode === 'user-view';
  }

  /**
   * Parse `ssh|stelnet [-l user] [-p port] host [command...]`. Returns
   * null for a malformed invocation or for exec mode (`command` present)
   * — both fall through to the device's synchronous one-shot client,
   * which already handles those correctly.
   */
  private parseSshInteractiveTarget(
    trimmed: string,
  ): { user: string | null; host: string; port: number } | null {
    const args = trimmed.split(/\s+/).slice(1);
    let user: string | null = null;
    let port = 22;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-l' && args[i + 1]) { user = args[++i]; continue; }
      if (a === '-p' && args[i + 1]) {
        const n = Number.parseInt(args[++i], 10);
        if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
        continue;
      }
      if (a.startsWith('-')) continue;
      rest.push(a);
    }
    if (rest.length !== 1) return null;
    const m = /^(?:([\w.-]+)@)?([\w.-]+)$/.exec(rest[0]);
    if (!m) return null;
    return { user: user ?? m[1] ?? null, host: m[2], port };
  }

  /**
   * Build the interactive-login flow for an outbound `ssh`/`stelnet`
   * launch: resolve the target, gate it the same way an inbound SSH
   * connection would be gated, prompt for a password (OpenSSH-style
   * retry wording), then push a full nested {@link TerminalSession} for
   * the remote device so commands genuinely execute there — mirroring
   * what Linux and Windows already do for outbound SSH.
   */
  private buildSshInteractiveFlowSteps(trimmed: string): InteractiveStep[] | null {
    const parsed = this.parseSshInteractiveTarget(trimmed);
    if (!parsed) return null;
    const { host, port } = parsed;

    const sourceIp = this.firstLocalIp();
    const localHostname = this.device.getHostname?.() ?? '';
    if (!sourceIp) {
      return [{ type: 'output', outputLines: [`ssh: connect to host ${host} port ${port}: Network is unreachable`] }];
    }
    // Matches the exec-mode client's own default (runOutboundSshClient) —
    // real IOS/VRP `ssh host` with no `-l`/`user@` defaults to 'admin'.
    const user = parsed.user ?? 'admin';

    const found = findHostByAddress(host);
    if (!found) {
      return [{ type: 'output', outputLines: [`ssh: Could not resolve hostname ${host}: Name or service not known`] }];
    }
    if (found.poweredOff || found.interfaceDown) {
      return [{ type: 'output', outputLines: [`ssh: connect to host ${host} port ${port}: No route to host`] }];
    }

    type RemoteSurface = {
      isSshActive?: () => boolean;
      sshdAcceptsLogin?: (u: string) => { ok: boolean; reason?: string };
      recordSshLogin?: (u: string, fromIp: string, fromHost: string, accepted: boolean) => void;
      getSshHost?: () => {
        isSshActive?: () => boolean;
        acceptsLogin?: (u: string) => { ok: boolean; reason?: string };
        evaluate?: (req: unknown) => { outcome: string };
      };
    };
    const remoteDevice = found.device;
    const remote = remoteDevice as unknown as RemoteSurface;
    const sshActive = typeof remote.isSshActive === 'function'
      ? remote.isSshActive()
      : remote.getSshHost?.()?.isSshActive?.() ?? false;
    if (!sshActive) {
      remote.recordSshLogin?.(user, sourceIp, localHostname, false);
      return [{ type: 'output', outputLines: [`ssh: connect to host ${host} port ${port}: Connection refused`] }];
    }

    const gate = remote.sshdAcceptsLogin?.(user) ?? remote.getSshHost?.()?.acceptsLogin?.(user) ?? { ok: true };
    if (!gate.ok) {
      remote.recordSshLogin?.(user, sourceIp, localHostname, false);
      return [{ type: 'output', outputLines: [`${user}@${host}: Permission denied (publickey,password).`] }];
    }

    let attempts = 0;
    return [
      {
        type: 'password',
        prompt: `${user}@${host}'s password: `,
        mask: 'hidden',
        storeAs: 'cli_ssh_password',
        validation: (pwd: string) => {
          const ok = this.verifySshCredentials(remoteDevice, user, host, port, sourceIp, localHostname, pwd);
          if (ok) return { valid: true };
          attempts++;
          remote.recordSshLogin?.(user, sourceIp, localHostname, false);
          if (attempts >= 3) {
            return { valid: false, maxRetries: 2, errorMessage: `${user}@${host}: Permission denied (publickey,password).` };
          }
          return { valid: false, maxRetries: 2, errorMessage: 'Permission denied, please try again.' };
        },
      },
      {
        type: 'execute',
        action: async () => {
          const child = createSessionForDevice(remoteDevice, `${this.id}>ssh`);
          if (!child) return;
          const clientPort = 50_000 + (user.length * 7 % 10_000);
          const serverIp = this.firstDeviceIp(remoteDevice) ?? host;
          this.adoptRemoteChild(child, user, host, {
            SSH_CONNECTION: `${sourceIp} ${clientPort} ${serverIp} ${port}`,
            SSH_CLIENT: `${sourceIp} ${clientPort} ${port}`,
          });
        },
      },
    ];
  }

  /**
   * `telnet host [port]` from a router CLI. One real connection, and the
   * remote's own text from there on — the outbound verb used to print a
   * banner and return.
   */
  private async enterTelnet(args: string[]): Promise<void> {
    const sub = await launchTelnet(args, {
      device: this.device,
      emit: (text) => this.addLine(text),
    });
    if (!sub) { this.notify(); return; }

    this.telnetSubShell = sub;
    const opening = await sub.begin();
    for (const line of opening.output) this.addLine(line);
    if (opening.exit) this.telnetSubShell = null;
    this.notify();
  }

  private async runTelnetLine(line: string): Promise<void> {
    const sub = this.telnetSubShell;
    if (!sub) return;
    const result = await sub.processLine(line);
    for (const out of result.output) this.addLine(out);
    if (result.exit) { sub.dispose(); this.telnetSubShell = null; }
    this.notify();
  }

  /** First configured IPv4 address on `dev`, or null. */
  private firstDeviceIp(dev: Equipment): string | null {
    for (const port of dev.getPorts()) {
      const ip = port.getIPAddress();
      if (ip) return ip.toString();
    }
    return null;
  }

  /**
   * Validate <user, password> against whatever credential store the
   * remote vendor exposes — direct `checkPassword` for Linux/Windows
   * hosts, or the SSH host's AAA evaluator for routers/switches.
   */
  private verifySshCredentials(
    device: Equipment, user: string, host: string, port: number,
    sourceIp: string, sourceHostname: string, password: string,
  ): boolean {
    const dev = device as unknown as {
      checkPassword?: (u: string, p: string) => boolean;
      userMgr?: { checkPassword?: (u: string, p: string) => boolean };
      getSshHost?: () => { evaluate?: (req: unknown) => { outcome: string } };
    };
    if (typeof dev.checkPassword === 'function') return dev.checkPassword(user, password);
    if (typeof dev.userMgr?.checkPassword === 'function') return dev.userMgr.checkPassword(user, password);
    if (typeof dev.getSshHost === 'function') {
      try {
        const req = SshConnectionRequest.create({
          requestedUser: user,
          requestedHost: host,
          requestedPort: port,
          sourceIp,
          sourceHostname,
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
   * Hook fired before a command is dispatched to the device. A subclass returns
   * true to claim the command and drive it as a foreground/background async job
   * (streaming ping, live debug, …) instead of the one-shot block path.
   */
  protected tryInterceptAsyncCommand(_command: string): boolean { return false; }

  // ── Flow completion hook ────────────────────────────────────────

  protected override onFlowComplete(): void {
    this.updatePrompt();
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(reverse: boolean = false): void {
    const source = new FullLineSource((line) => this.resolveCliTabCandidates(line));
    const out = this.cliCompletion.handleTab(this.input, source, reverse);
    if (!out.changed) return;
    this.input = out.input;
    this.notify();
  }

  // ── Inline help ─────────────────────────────────────────────────

  private showInlineHelp(currentInput: string): void {
    this.addLine(`${this.prompt}${currentInput}?`);

    const helpText = this.resolveCliHelp(currentInput);

    if (helpText) this.addLine(helpText);
    // Input is NOT cleared — user continues typing
  }

  protected resolveCliHelp(currentInput: string): string {
    return this.cliDevice.cliHelp(currentInput);
  }

  protected resolveCliTabCandidates(input: string): string[] {
    return this.cliDevice.cliTabCandidates(input);
  }

  protected override computeGhostSuggestion(): string | null {
    if (this.isBooting || this.pagerLines !== null) return null;
    const source = new FullLineSource((line) => this.resolveCliTabCandidates(line));
    return ghostRemainder(this.input, source);
  }

  // ── Pager ───────────────────────────────────────────────────────

  /**
   * Effective page size for this terminal. Subclasses with a per-vty
   * session override to read `session.state.terminalLength`. Value 0
   * means the pager is disabled (`terminal length 0` / `screen-length
   * disable` — see terminal_gap.md §5.3). Default: 24 lines.
   */
  protected getPageSize(): number { return DEFAULT_PAGE_SIZE; }

  private startPager(allLines: string[]): void {
    const pageSize = this.getPageSize();
    // `terminal length 0` / `screen-length disable` — dump everything,
    // no --More-- prompt.
    if (pageSize <= 0) {
      this.addLines(allLines);
      return;
    }
    const firstPage = allLines.slice(0, pageSize);
    this.addLines(firstPage);

    if (allLines.length > pageSize) {
      this.pagerLines = allLines;
      this.pagerOffset = pageSize;
      this.inputMode = { type: 'pager', indicator: this.getPagerIndicator() };
      this.notify();
    }
  }

  private pagerNextPage(): void {
    if (!this.pagerLines) return;
    const pageSize = this.getPageSize() || DEFAULT_PAGE_SIZE;
    const next = this.pagerLines.slice(this.pagerOffset, this.pagerOffset + pageSize);
    this.addLines(next);
    if (this.pagerOffset + pageSize >= this.pagerLines.length) {
      this.pagerQuit();
    } else {
      this.pagerOffset += pageSize;
      this.notify();
    }
  }

  private pagerNextLine(): void {
    if (!this.pagerLines) return;
    if (this.pagerOffset < this.pagerLines.length) {
      this.addLine(this.pagerLines[this.pagerOffset]);
      if (this.pagerOffset + 1 >= this.pagerLines.length) {
        this.pagerQuit();
      } else {
        this.pagerOffset++;
        this.notify();
      }
    }
  }

  private pagerQuit(): void {
    this.pagerLines = null;
    this.pagerOffset = 0;
    this.inputMode = { type: 'normal' };
    this.notify();
  }
}

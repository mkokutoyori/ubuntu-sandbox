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

import { ROUTER_SSH_LOCAL_USER } from '@/network/protocols/ssh/localFs/sshLocalFsFor';
import type { Equipment, ICLIDevice } from '@/network';
import { openWireSshShell, resolveSshTarget } from '@/terminal/ssh/wireSshLogin';
import { QueuedTerminalIOCancelled } from '@/network/protocols/ssh/session/QueuedTerminalIO';
import type { SshSession } from '@/network/protocols/ssh/session/SshSession';
import type { ISshShellChannel } from '@/network/protocols/ssh/channels/ISshChannel';
import type { SshDialect } from '@/terminal/ssh/sshDialect';
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
import { launchTelnet } from '@/terminal/subshells/telnetLaunch';
import type { TelnetDialect } from '@/terminal/subshells/telnetDialect';
import type { ISubShell } from '@/terminal/subshells/ISubShell';
import { SshInteractiveSubShell } from '@/terminal/subshells/SshInteractiveSubShell';
import { parseSshCommandLine } from '@/terminal/sessions/sshArgs';
import { parseBashPrompt } from '@/network/devices/linux/shell/BashPrompt';
import { establishedSessionLiveness } from '@/network/protocols/ssh/sessionLiveness';
import type { CliLineKind } from '@/network/devices/shells/vty/CliShellSession';

interface LineRegistryPort {
  open(input: { user: string; privilege?: number; fromIp: string; transport?: string }):
    { id: string; line: string; lineKind: CliLineKind; lineIndex: number } | null;
  close(id: string, reason?: string): unknown;
  subscribeClose(id: string, cb: (reason: string) => void): () => void;
}

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
    if (this.remoteSubShell) return this.remoteSubShell.getPrompt();
    if (this.promptHiddenUntilFirstKey) return '';
    return this.prompt;
  }

  /**
   * An outbound `telnet` session held open by this terminal. A CLI
   * terminal has no general sub-shell stack — the one case that needs
   * it is telnet, whose remote answers arrive asynchronously off a real
   * socket (docs/PRD-VTY-Transport.md §2.1 item 6).
   */
  private remoteSubShell: ISubShell | null = null;
  private quoteNextKey = false;

  protected abstract getDefaultPrompt(): string;

  protected abstract isTopLevelExit(line: string): boolean;

  protected exitClosesLocalSession(): boolean { return false; }

  /** The vendor-specific "go to top-level" command (Cisco: 'end', Huawei: 'return') */
  protected abstract getCtrlZCommand(): string;

  /** The pager indicator text */
  protected abstract getPagerIndicator(): string;

  /**
   * How this vendor's own telnet client words its transcript. A router
   * that answered a refused connection with the BSD client's
   * `telnet: connect to address …` was reporting a real event in another
   * platform's voice.
   */
  protected abstract getTelnetDialect(): TelnetDialect;

  protected abstract getSshDialect(): SshDialect;

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
    if (this.pendingSshIO?.isWaitingForInput) return this.inputMode;
    if (this.isFlowActive) {
      return this.inputMode; // set by advanceFlow()
    }
    return this.inputMode;
  }

  // ── Line occupancy ──────────────────────────────────────────────

  private lineRecordId: string | null = null;

  private lineRegistry(): LineRegistryPort | null {
    return (this.device as unknown as {
      getSshSessionRegistry?: () => LineRegistryPort;
    }).getSshSessionRegistry?.() ?? null;
  }

  private occupyLine(): void {
    if (this.lineRecordId !== null) return;
    const registry = this.lineRegistry();
    if (!registry) return;
    const record = registry.open({
      user: '', privilege: 1, fromIp: '',
      transport: this.onVtyLine() ? 'telnet' : 'console',
    });
    if (!record) return;
    this.lineRecordId = record.id;
    this.occupiedLineName = record.line;
    this.onLineAssigned(record.lineKind, record.lineIndex, record.id);
    const stopWatching = registry.subscribeClose(record.id, (reason) => {
      this.lineRecordId = null;
      if (reason === 'logout') return;
      this.markDisconnected(reason, `[Connection to ${record.line} closed by remote host]`);
    });
    this.registerTearDown(() => {
      stopWatching();
      if (this.lineRecordId === null) return;
      this.lineRegistry()?.close(this.lineRecordId, 'logout');
      this.lineRecordId = null;
    });
  }

  /** Overridden by vendors that can sit on a vty rather than the console. */
  protected onVtyLine(): boolean { return false; }

  /** Overridden by vendors carrying a per-line CLI state bag. */
  protected onLineAssigned(_kind: CliLineKind, _index: number, _recordId: string): void { /* vendor hook */ }

  private occupiedLineName: string | null = null;

  /** The line this session occupies (`con 0`, `vty 2`, …), or null. */
  occupiedLine(): string | null { return this.occupiedLineName; }

  // ── Boot sequence ───────────────────────────────────────────────

  async init(): Promise<void> {
    this.occupyLine();
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
    if (this.bootEndsOnReturnNotice()) this.promptHiddenUntilFirstKey = true;
  }

  /** Fallback boot lines if device doesn't provide getBootSequence(). */
  protected abstract getFallbackBootLines(): string[];

  // ── Close callback ─────────────────────────────────────────────

  protected _onRequestClose?: () => void;
  onRequestClose(cb: () => void): void { this._onRequestClose = cb; }

  /**
   * Une CONSOLE ne se ferme pas quand la session se termine : elle se
   * repropose.
   *
   * `exit` depuis un mode EXEC termine bien la session — c'est le vrai
   * comportement d'IOS et il est verifie par test. Mais un onglet de
   * terminal est la LIGNE console, un cable soude a la machine : la
   * session finit, la ligne reste. Une vraie machine annonce alors
   * `<nom> con0 is now available` puis `Press RETURN to get started.` et
   * attend une frappe. Ici l'onglet DISPARAISSAIT, donc `exit` — le geste
   * qu'on apprend pour quitter le mode privilegie — coupait l'acces a la
   * machine entiere, et il fallait rouvrir un terminal pour revenir.
   *
   * La fermeture reste juste pour une session ENFANT (un `ssh`/`telnet`
   * ouvert depuis un autre terminal) : la, la session EST la connexion.
   */
  protected endExecSession(): void {
    this.fermerSessionEnregistree();
    this.viderHistoriqueDeSession();
    const banniere = this.consoleReleasedBanner();
    if (!banniere) { this._onRequestClose?.(); return; }
    for (const l of banniere) this.addLine(l);
    this.consoleAwaitingReturn = true;
    this.prompt = '';
    this.notify();
  }

  /**
   * Les lignes annoncant que la console se libere, ou null pour fermer
   * l'onglet comme avant. Null par defaut : n'invente pas la formulation
   * d'un constructeur dont on n'a pas la transcription.
   */
  protected consoleReleasedBanner(): string[] | null { return null; }

  /**
   * Liberer la ligne dans le registre de l'equipement. Sans cela un
   * operateur parti restait indefiniment dans `show users` : la session
   * etait OUVERTE a l'authentification et n'etait jamais fermee, donc la
   * vue decrivait comme presents des gens qui avaient quitte la machine
   * — et sur la console, ou il n'y a qu'une ligne, la suivante etait
   * refusee faute de place.
   *
   * La session visee est celle de CETTE ligne : une console ferme la
   * console, jamais la vty de quelqu'un d'autre.
   */
  private fermerSessionEnregistree(): void {
    const dev = this.device as unknown as {
      getSshSessionRegistry?: () => {
        closeWhere(p: (s: { lineKind?: string; transport?: string }) => boolean, r?: string): number;
      };
    };
    dev.getSshSessionRegistry?.().closeWhere((s) => s.lineKind === 'con', 'logout');
  }

  /**
   * `show history` decrit la session EXEC courante. `VtySnapshot` porte
   * deja `cmdHistory` — l'etat par session existait — mais la console le
   * traversait sans jamais le remettre a zero, si bien que l'operateur
   * suivant heritait des commandes du precedent.
   */
  private viderHistoriqueDeSession(): void {
    const v = (this as unknown as { vty?: { state: { cmdHistory: string[] } } | null }).vty;
    if (v) v.state.cmdHistory = [];
  }

  /** La console attend la frappe qui rouvre une session EXEC. */
  protected consoleAwaitingReturn = false;

  protected promptHiddenUntilFirstKey = false;

  protected bootEndsOnReturnNotice(): boolean {
    return this.lines.some((l) => l.text === 'Press RETURN to get started.');
  }

  private revealPromptOnFirstKey(): void {
    if (!this.promptHiddenUntilFirstKey) return;
    this.promptHiddenUntilFirstKey = false;
    this.updatePrompt();
  }

  /**
   * `Press RETURN to get started.` — that RETURN OPENS the session, it
   * does not submit a line. Letting it fall through to the ordinary Enter
   * handling made the console echo an extra line and show the prompt
   * twice, which is not what a real console does.
   *
   * The condition is narrow on purpose: only a bare Enter, only while the
   * banner is still up, only with nothing pending to run.
   *
   * "Nothing pending" must be asked of BOTH buffers. Typing fills
   * `input`; the scripted paths call `setInputBuf`, which fills
   * `_inputBuf` and leaves `input` empty. Asking only the first let this
   * gate swallow every scripted SSH command — measured, not feared: nine
   * cases of `ssh-liveness-vendor-agnostic` went down, and a wider
   * version of this same gate had already done it once before.
   */
  private returnOpensTheSession(e: KeyEvent): boolean {
    if (!this.promptHiddenUntilFirstKey || e.key !== 'Enter') return false;
    return this.input === '' && this.getInputBuf() === '';
  }

  /** Rouvrir une session EXEC apres la frappe. */
  protected reopenConsoleExec(): void {
    this.updatePrompt();
    this.notify();
  }

  // ── Key handling ────────────────────────────────────────────────

  handleKey(e: KeyEvent): boolean {
    if (this.disposed) return false;
    if (this.pendingSshIO?.isWaitingForInput) return this.handleSshIOKey(e);
    return super.handleKey(e);
  }

  protected handleModeKey(e: KeyEvent): boolean {
    if (this.returnOpensTheSession(e)) {
      this.revealPromptOnFirstKey();
      this.notify();
      return true;
    }
    this.revealPromptOnFirstKey();

    // La console est libre : toute frappe est absorbee, seule RETURN
    // rouvre une session — comme sur une vraie ligne console.
    if (this.consoleAwaitingReturn) {
      if (e.key === 'Enter') {
        this.consoleAwaitingReturn = false;
        this.input = '';
        this.reopenConsoleExec();
      }
      return true;
    }

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
    if (e.key.toLowerCase() === 'v' && e.ctrlKey && !e.shiftKey) {
      this.quoteNextKey = true;
      return false;
    }

    // ? (inline help — intercepted before reaching input)
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey
      && (this.remoteSubShell === null || this.remoteSubShell.supportsInlineHelp?.() === true)) {
      if (this.quoteNextKey) {
        this.quoteNextKey = false;
        return false;
      }
      if (this.remoteSubShell === null) this.showInlineHelp(this.input);
      else void this.showRemoteInlineHelp(this.remoteSubShell, this.input);
      return true;
    }
    if (this.quoteNextKey && e.key.length === 1) this.quoteNextKey = false;

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

    if (this.remoteSubShell) {
      await this.runRemoteLine(trimmed);
      return;
    }

    const clientLine = this.stripClientPrefix(trimmed);
    const firstWord = clientLine.split(/\s+/)[0]?.toLowerCase();
    if (firstWord === 'telnet') {
      await this.enterTelnet(clientLine.split(/\s+/).slice(1));
      return;
    }
    if (firstWord && this.sshInteractiveVerbs().includes(firstWord) && this.sshInteractiveModeAllowed()) {
      if (await this.enterWireSsh(clientLine)) return;
    }

    const steps = this.buildInteractiveFlow(trimmed);
    if (steps) {
      this.startFlowFromSteps(steps, trimmed);
      return;
    }

    if (this.tryInterceptAsyncCommand(trimmed)) return;

    const exitBeforeExec = this.exitClosesLocalSession()
      && this.isTopLevelExit(trimmed);

    try {
      const result = await this.executeOnDevice(trimmed);

      if (result === CONNECTION_CLOSED || exitBeforeExec) {
        this.endExecSession();
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

  protected stripClientPrefix(line: string): string { return line; }

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
   * `ssh|stelnet [-l user] [-p port] host` typed at the prompt. The router
   * resolves the name with its own resolver, asks the wire whether anything
   * answers, then lets the SSH layer raise the host-key and password
   * dialogs. Everything typed afterwards crosses the shell channel of the
   * established session; nothing about the remote is read from its object.
   * Returns `false` for an exec-mode line, which the device's one-shot
   * client keeps handling.
   */
  private async enterWireSsh(clientLine: string): Promise<boolean> {
    const verbs = this.sshInteractiveVerbs().join('|');
    const parsed = parseSshCommandLine(clientLine, new RegExp(`^(${verbs})(\\s|$)`));
    if (parsed === null || parsed.host === '' || parsed.command !== null) return false;

    const dialect = this.getSshDialect();
    const { host: typedHost, port } = parsed;
    if (!this.firstLocalIp()) {
      this.addLine(dialect.unreachable(typedHost, port));
      return true;
    }
    const target = await resolveSshTarget(this.device as Equipment, typedHost, port, dialect);
    if (target.kind === 'failed') {
      this.addLine(target.line);
      return true;
    }

    const asksUsername = parsed.user === null && clientLine.split(/\s+/)[0] === 'stelnet';
    const io = this.createSshTerminalIO();
    let outcome: Awaited<ReturnType<typeof openWireSshShell>> | null = null;
    let user = parsed.user ?? 'admin';
    try {
      if (asksUsername) {
        const typed = (await io.readInput('Please input the username:', false)).trim();
        if (typed === '') return true;
        user = typed;
      }
      outcome = await openWireSshShell({
        device: this.device as Equipment,
        localUser: ROUTER_SSH_LOCAL_USER,
        user,
        host: target.address,
        port,
        io,
        strict: parsed.strict ?? 'accept-new',
        quiet: parsed.quiet,
        identityFiles: parsed.identityFiles,
        authentication: parsed.authentication,
        algorithms: parsed.algorithms,
      });
    } catch (error) {
      if (!(error instanceof QueuedTerminalIOCancelled)) throw error;
      this.addLine('^C');
      return true;
    } finally {
      this.pendingSshIO = null;
      this.notify();
    }

    if (outcome.kind === 'cancelled') {
      this.addLine('^C');
    } else if (outcome.kind === 'host-key-changed') {
      this.addLine('Host key verification failed.');
    } else if (outcome.kind === 'rejected' || outcome.kind === 'unreachable') {
      this.addLine(outcome.message);
    } else if (outcome.kind === 'connected') {
      this.openRemoteShell(outcome.session, outcome.channel, user, typedHost, target.address, parsed.quiet);
    }
    return true;
  }

  private openRemoteShell(
    session: SshSession, channel: ISshShellChannel,
    user: string, typedHost: string, address: string, quiet: boolean,
  ): void {
    if (!quiet) {
      const greeting = (channel as { initialMotd?: () => string | null }).initialMotd?.() ?? '';
      for (const greetingLine of greeting.replace(/\n+$/, '').split('\n')) {
        if (greetingLine.length > 0) this.addLine(greetingLine);
      }
    }
    const opening = (channel as { initialPrompt?: () => string | null }).initialPrompt?.() ?? null;
    const promptHost = (opening !== null ? parseBashPrompt(opening)?.hostname : undefined) ?? typedHost;
    this.remoteSubShell = new SshInteractiveSubShell(
      session, channel, user, typedHost, `/home/${user}`,
      () => session.disconnect(),
      promptHost,
      establishedSessionLiveness(session, this.device as Equipment, address),
      (footer) => { this.addLine(footer); this.remoteSubShell = null; this.updatePrompt(); },
      (line) => this.addLine(line),
    );
    this.notify();
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
      dialect: this.getTelnetDialect(),
    });
    if (!sub) { this.notify(); return; }

    this.remoteSubShell = sub;
    const opening = await sub.begin();
    for (const line of opening.output) this.addLine(line);
    if (opening.exit) this.remoteSubShell = null;
    this.notify();
  }

  private async runRemoteLine(line: string): Promise<void> {
    const sub = this.remoteSubShell;
    if (!sub) return;
    let result = await sub.processLine(line, (text) => this.addLine(text));
    for (;;) {
      for (const out of result.output) this.addLine(out);
      if (result.exit) { sub.dispose(); this.remoteSubShell = null; break; }
      if (result.pendingInput === undefined || sub.handleInput === undefined) break;
      const io = this.createSshTerminalIO();
      const answer = await io.readInput(result.pendingInput.promptText, result.pendingInput.kind === 'password');
      this.pendingSshIO = null;
      result = await sub.handleInput(answer);
    }
    this.notify();
  }

  /**
   * Hook fired before a command is dispatched to the device. A subclass returns
   * true to claim the command and drive it as a foreground/background async job
   * (streaming ping, live debug, …) instead of the one-shot block path.
   */
  protected tryInterceptAsyncCommand(_command: string): boolean { return false; }

  // ── Flow completion hook ────────────────────────────────────────

  protected override onFlowComplete(): void {
    this.promptHiddenUntilFirstKey = false;
    this.updatePrompt();
  }

  // ── Tab completion ──────────────────────────────────────────────

  protected onTab(reverse: boolean = false): void {
    if (this.remoteSubShell !== null) return;
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

  private async showRemoteInlineHelp(remote: ISubShell, currentInput: string): Promise<void> {
    this.addLine(`${remote.getPrompt()}${currentInput}?`);
    for (const helpLine of await remote.inlineHelpAsync?.(currentInput) ?? []) this.addLine(helpLine);
    this.notify();
  }

  protected resolveCliHelp(currentInput: string): string {
    return this.cliDevice.cliHelp(currentInput);
  }

  protected resolveCliTabCandidates(input: string): string[] {
    return this.cliDevice.cliTabCandidates(input);
  }

  protected override computeGhostSuggestion(): string | null {
    if (this.isBooting || this.pagerLines !== null || this.remoteSubShell !== null) return null;
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

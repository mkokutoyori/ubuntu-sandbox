import type { ICLIDevice } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType, type KeyEvent } from './TerminalSession';
import { BSD_TELNET, type TelnetDialect } from '@/terminal/subshells/telnetDialect';
import { CyclingPolicy, type CompletionPolicy } from '@/terminal/completion';
import { Firewall } from '@/network/devices/firewall/Firewall';
import { PING_NO_ROUTE } from '@/network/devices/firewall/diag/FirewallPing';
import type { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import type { InteractiveStep } from '@/terminal/core/types';
import type { CapturedFrame } from '@/network/devices/firewall/diag/PacketCapture';
import {
  snifferHeader, snifferTrailer, renderFrame,
} from '@/network/devices/firewall/vendors/fortios/diag/snifferRenderer';
import { getDefaultEventBus } from '@/events/EventBus';

const PING_INTERVAL_MS = 300;
const SNIFFER_POLL_MS = 50;

const FORTI_THEME: TerminalTheme = {
  sessionType: 'linux',
  backgroundColor: '#12161c',
  textColor: '#e2e8f0',
  errorColor: '#f87171',
  promptColor: '#ef4444',
  fontFamily: 'monospace',
  infoBarBg: '#0b0e13',
  infoBarText: '#ef4444',
  infoBarBorder: 'rgba(239,68,68,0.5)',
  bootColor: '#dc2626',
  pagerColor: '#facc15',
};

export class FortiTerminalSession extends CLITerminalSession {
  constructor(id: string, device: ICLIDevice) {
    super(id, device);
  }

  override async init(): Promise<void> {
    await super.init();
    this.startConsoleLogin();
    this.watchPowerCycle();
  }

  private watchPowerCycle(): void {
    if (!(this.device instanceof Firewall)) return;
    const stop = getDefaultEventBus().subscribe('device.power-on', (event) => {
      if ((event.payload as { id?: string }).id !== this.device.id) return;
      this.rearmConsole();
    });
    this.registerTearDown(stop);
  }

  private rearmConsole(): void {
    setTimeout(() => {
      if (this.disposed || this.isFlowActive) return;
      this.startConsoleLogin();
      this.updatePrompt();
      this.notify();
    }, 0);
  }

  override markReconnected(notice?: string): void {
    super.markReconnected(notice);
    this.rearmConsole();
  }

  protected override handleNormalKey(e: KeyEvent): boolean {
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const shell = (this.device as FortiGate).getShell?.();
      if (shell?.abortContinuation()) {
        this.setInput('');
        return true;
      }
    }
    return super.handleNormalKey(e);
  }

  override platformLabel(): string { return 'Fortinet FortiOS'; }

  protected override completionPolicy(): CompletionPolicy {
    return new CyclingPolicy();
  }

  getSessionType(): SessionType { return 'linux'; }
  getTheme(): TerminalTheme { return FORTI_THEME; }

  protected getDefaultPrompt(): string {
    return `${this.device.getHostname()} # `;
  }

  protected getCtrlZCommand(): string { return 'end'; }
  protected getPagerIndicator(): string { return '--More--'; }

  protected getTelnetDialect(): TelnetDialect { return BSD_TELNET; }

  protected isTopLevelExit(line: string): boolean {
    const word = line.trim().toLowerCase();
    return word === 'exit' || word === 'quit';
  }

  getInfoBarContent() {
    return {
      left: `${this.device.getHostname()} — FortiGate`,
      right: '? = help | Tab = complete',
    };
  }

  private startConsoleLogin(): void {
    if (!(this.device instanceof Firewall)) return;
    if (!this.device.getConsoleSettings().requiresLogin()) { this.loggedIn = true; return; }
    this.loggedIn = false;
    for (const line of this.forti().getLoginBanners().lines('pre')) this.addLine(line);
    this.startFlowFromSteps(this.buildLoginSteps(), '', undefined, { authGate: true });
  }

  protected override exitClosesLocalSession(): boolean { return true; }

  protected override stripClientPrefix(line: string): string {
    const match = /^execute\s+(ssh|telnet)\b\s*(.*)$/i.exec(line.trim());
    return match ? `${match[1].toLowerCase()} ${match[2]}`.trim() : line;
  }

  protected override endExecSession(): void {
    this.forti().onAdminLogout(this.forti().getShell().getAdminIdentity() ?? 'admin');
    this.startConsoleLogin();
    this.updatePrompt();
    this.notify();
  }

  protected override getPageSize(): number {
    if (this.device instanceof Firewall
      && !this.device.getConsoleSettings().pagesOutput()) return 0;
    return super.getPageSize();
  }

  protected override restartAuthGate(): void { this.startConsoleLogin(); }

  protected override onFlowComplete(): void {
    super.onFlowComplete();
    if (!this.lastFlowWasAuthGate || this.loggedIn) return;
    this.startConsoleLogin();
  }

  private loggedIn = false;

  private forti(): FortiGate { return this.device as unknown as FortiGate; }

  private buildLoginSteps(): InteractiveStep[] {
    return [
      /* 0 */ {
        type: 'text', prompt: `${this.device.getHostname()} login: `,
        storeAs: 'forti_user', allowEmpty: true,
      },
      /* 1 */ { type: 'password', prompt: 'Password: ', mask: 'hidden', storeAs: 'forti_password' },
      /* 2 */ {
        type: 'execute',
        action: async (ctx) => {
          const user = (ctx.values.get('forti_user') ?? '').trim();
          const password = ctx.values.get('forti_password') ?? '';
          const accepted = this.forti().authenticateAdmin(user, password);
          ctx.values.set('forti_accepted', accepted ? 'yes' : 'no');
          if (!accepted) { this.addLine('Login incorrect'); this.addLine(''); }
        },
      },
      /* 3 */ { type: 'branch', predicate: (ctx) => ctx.values.get('forti_accepted') === 'yes' ? 4 : 0 },
      /* 4 */ {
        type: 'branch',
        predicate: (ctx) => {
          const user = (ctx.values.get('forti_user') ?? '').trim();
          this.loggedIn = true;
          this.forti().getShell().setAdminIdentity(user);
          for (const line of this.forti().getLoginBanners().lines('post')) {
            this.addLine(line);
          }
          return this.forti().adminMustChoosePassword(user) ? 5 : 9;
        },
      },
      /* 5 */ {
        type: 'output',
        outputLines: ['You are forced to change your password, please input a new password.'],
      },
      /* 6 */ { type: 'password', prompt: 'New Password: ', mask: 'hidden', storeAs: 'forti_new' },
      /* 7 */ { type: 'password', prompt: 'Confirm Password: ', mask: 'hidden', storeAs: 'forti_confirm' },
      /* 8 */ {
        type: 'branch',
        predicate: (ctx) => {
          const chosen = ctx.values.get('forti_new') ?? '';
          const confirmed = ctx.values.get('forti_confirm') ?? '';
          if (chosen.length === 0 || chosen !== confirmed) {
            this.addLine('Passwords do not match.');
            return 5;
          }
          this.applyNewPassword((ctx.values.get('forti_user') ?? '').trim(), chosen);
          this.addLine('Welcome !');
          this.addLine('');
          return 9;
        },
      },
      /* 9 */ { type: 'output', outputLines: [] },
    ];
  }

  private applyNewPassword(user: string, password: string): void {
    const account = this.forti().getAdminAccount(user);
    if (!account) return;
    this.forti().applyAdminAccount({
      name: user, password, profile: account.profile,
      vdoms: [...account.vdoms], trustHosts: account.trustHosts.map(h => ({ ...h })),
    });
  }

  protected override tryInterceptAsyncCommand(command: string): boolean {
    return this.tryStartPingStream(command) || this.tryStartSnifferStream(command);
  }

  private tryStartSnifferStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const device = this.device;
    if (!(device instanceof Firewall)) return false;

    const plan = this.forti().getShell().snifferPlanFor(commandLine);
    if (!plan) return false;

    const run = device.beginSniffer(plan);
    let received = 0;
    let startedAt = 0;
    const emitTrailer = (ctx: { sink: { line(text: string): void } }) => {
      for (const line of snifferTrailer(received)) ctx.sink.line(line);
    };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        for (const line of snifferHeader(plan)) ctx.sink.line(line);

        const show = (entry: CapturedFrame) => {
          if (startedAt === 0) startedAt = entry.at;
          received++;
          ctx.sink.line(renderFrame(entry, plan.verbosity, startedAt));
        };

        const stop = run.onFrame((entry) => {
          if (run.wanted > 0 && received >= run.wanted) return;
          show(entry);
        });
        try {
          while (!ctx.cancelled() && (run.wanted === 0 || received < run.wanted)) {
            await ctx.delay(SNIFFER_POLL_MS);
          }
        } finally { stop(); }

        if (ctx.cancelled()) return;
        emitTrailer(ctx);
      },
      onInterrupt: (ctx) => emitTrailer(ctx),
    });
    return job !== null;
  }

  private tryStartPingStream(commandLine: string): boolean {
    if (this.hasForegroundAsyncJob) return false;
    const device = this.device;
    if (!(device instanceof Firewall)) return false;

    const words = commandLine.trim().split(/\s+/);
    if (words[0] !== 'execute' || words[1] !== 'ping' || words.length !== 3) return false;

    const run = device.beginPing(words[2]);
    if (!run) { this.addLine(PING_NO_ROUTE); this.notify(); return true; }

    const count = device.pingRepeatCount();
    let sent = 0;
    const emitStats = (ctx: { sink: { line(text: string): void } }) => {
      for (const line of run.statistics(sent).split('\n')) ctx.sink.line(line);
    };

    const job = this.startAsyncCommand({
      mode: 'foreground',
      kind: 'streaming',
      command: commandLine,
      run: async (ctx) => {
        ctx.sink.line(run.header);
        for (let sequence = 0; sequence < count && !ctx.cancelled(); sequence++) {
          const reply = run.step(sequence);
          sent++;
          if (reply !== null) ctx.sink.line(reply);
          if (sequence + 1 < count) await ctx.delay(PING_INTERVAL_MS);
        }
        if (ctx.cancelled()) return;
        emitStats(ctx);
      },
      onInterrupt: (ctx) => emitStats(ctx),
    });
    return job !== null;
  }

  protected getFallbackBootLines(): string[] {
    return ['', 'FortiGate booting...', '', 'System is starting...', ''];
  }
}

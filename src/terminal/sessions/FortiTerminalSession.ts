import type { ICLIDevice } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType } from './TerminalSession';
import { BSD_TELNET, type TelnetDialect } from '@/terminal/subshells/telnetDialect';
import { CyclingPolicy, type CompletionPolicy } from '@/terminal/completion';
import { Firewall } from '@/network/devices/firewall/Firewall';
import { PING_NO_ROUTE } from '@/network/devices/firewall/diag/FirewallPing';

const PING_INTERVAL_MS = 300;

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

  protected override tryInterceptAsyncCommand(command: string): boolean {
    return this.tryStartPingStream(command);
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

import type { ICLIDevice } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType } from './TerminalSession';
import { BSD_TELNET, type TelnetDialect } from '@/terminal/subshells/telnetDialect';

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

  protected getFallbackBootLines(): string[] {
    return ['', 'FortiGate booting...', '', 'System is starting...', ''];
  }
}

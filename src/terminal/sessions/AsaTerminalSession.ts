import type { ICLIDevice } from '@/network';
import { IOS_SSH, type SshDialect } from '@/terminal/ssh/sshDialect';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType } from './TerminalSession';
import { IOS_TELNET, type TelnetDialect } from '@/terminal/subshells/telnetDialect';

const ASA_THEME: TerminalTheme = {
  sessionType: 'cisco',
  backgroundColor: '#1e1e1e',
  textColor: '#4ade80',
  errorColor: '#f87171',
  promptColor: '#4ade80',
  fontFamily: 'monospace',
  infoBarBg: '#111827',
  infoBarText: '#22c55e',
  infoBarBorder: 'rgba(34,197,94,0.5)',
  bootColor: '#16a34a',
  pagerColor: '#facc15',
};

export class AsaTerminalSession extends CLITerminalSession {
  constructor(id: string, device: ICLIDevice) {
    super(id, device);
  }

  override platformLabel(): string { return 'Cisco ASA'; }

  getSessionType(): SessionType { return 'cisco'; }
  getTheme(): TerminalTheme { return ASA_THEME; }

  protected getDefaultPrompt(): string {
    return `${this.device.getHostname()}>`;
  }

  protected getCtrlZCommand(): string { return 'end'; }
  protected getPagerIndicator(): string { return '<--- More --->'; }

  protected getTelnetDialect(): TelnetDialect { return IOS_TELNET; }

  protected getSshDialect(): SshDialect { return IOS_SSH; }

  protected isTopLevelExit(line: string): boolean {
    const word = line.trim().toLowerCase();
    return word === 'logout' || word === 'quit';
  }

  getInfoBarContent() {
    return {
      left: `${this.device.getHostname()} — Cisco ASA 5506-X`,
      right: '? = help | Tab = complete',
    };
  }

  protected getFallbackBootLines(): string[] {
    return [
      '',
      'Cisco Adaptive Security Appliance Software',
      'Booting system, please wait...',
      '',
      'Type help or \'?\' for a list of available commands.',
      '',
    ];
  }
}

/**
 * HuaweiTerminalSession — Huawei VRP terminal model.
 */

import { Equipment } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType } from './TerminalSession';

const HUAWEI_THEME: TerminalTheme = {
  sessionType: 'huawei',
  backgroundColor: '#1a1a2e',
  textColor: '#67e8f9',     // cyan-300
  errorColor: '#f87171',    // red-400
  promptColor: '#67e8f9',
  fontFamily: "monospace",
  infoBarBg: '#0f0f1e',
  infoBarText: '#0891b2',   // cyan-600
  infoBarBorder: 'rgba(8,145,178,0.5)',
  bootColor: '#06b6d4',     // cyan-500
  pagerColor: '#facc15',    // yellow-400
};

export class HuaweiTerminalSession extends CLITerminalSession {
  constructor(id: string, device: Equipment) {
    super(id, device);
  }

  getSessionType(): SessionType { return 'huawei'; }
  getTheme(): TerminalTheme { return HUAWEI_THEME; }

  protected getDefaultPrompt(): string {
    return `<${this.device.getHostname()}>`;
  }

  protected getCtrlZCommand(): string { return 'return'; }
  protected getPagerIndicator(): string { return '  ---- More ----'; }

  getInfoBarContent() {
    const deviceType = this.device.getType();
    const isSwitch = deviceType.includes('switch');
    return {
      left: `${this.device.getHostname()} — ${isSwitch ? 'S5720 Switch' : 'AR2220 Router'}`,
      right: '? = help | Tab = complete',
    };
  }

  protected getFallbackBootLines(): string[] {
    const hostname = this.device.getHostname();
    return [
      '',
      'Huawei Versatile Routing Platform Software',
      `VRP (R) software, Version 8.180 (${hostname} V800R021C10SPC100)`,
      'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD.',
      '',
      `HUAWEI ${hostname} uplink board starts...`,
      'Loading system software...',
      'System software loaded successfully.',
      '',
      `Info: ${hostname} system is ready.`,
      '',
    ];
  }
}

/**
 * CiscoTerminalSession — Cisco IOS terminal model.
 *
 * Defines which Cisco IOS commands require interactive prompts
 * (enable password, reload confirmation, copy confirmations, etc.)
 * via buildInteractiveFlow() → InteractiveFlowEngine.
 */

import { Equipment } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType } from './TerminalSession';
import { CiscoFlowBuilder } from '@/terminal/flows/CiscoFlowBuilder';
import type { InteractiveStep } from '@/terminal/core/types';

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
  constructor(id: string, device: Equipment) {
    super(id, device);
  }

  getSessionType(): SessionType { return 'cisco'; }
  getTheme(): TerminalTheme { return CISCO_THEME; }

  protected getDefaultPrompt(): string {
    return `${this.device.getHostname()}>`;
  }

  protected getCtrlZCommand(): string { return 'end'; }
  protected getPagerIndicator(): string { return ' --More-- '; }

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
   * Cisco IOS interactive commands:
   * - copy running-config startup-config → asks Destination filename
   * - reload → asks Proceed with reload? [confirm]
   * - erase startup-config → confirms erase
   */
  protected buildInteractiveFlow(command: string): InteractiveStep[] | null {
    const lower = command.toLowerCase().trim();

    if (lower === 'copy running-config startup-config' || lower === 'copy run start') {
      return CiscoFlowBuilder.copyRunningConfig();
    }

    if (lower === 'reload') {
      return CiscoFlowBuilder.reloadConfirmation();
    }

    if (lower === 'erase startup-config') {
      return CiscoFlowBuilder.eraseStartupConfig();
    }

    return null;
  }
}

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
import { CiscoFlowBuilder } from '@/terminal/flows/CiscoFlowBuilder';
import type { InteractiveStep } from '@/terminal/core/types';
import { Router } from '@/network/devices/Router';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import type { AsyncJobHandle } from '@/terminal/async';
import type { TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';

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
    if (device instanceof Router) {
      this.vty = device.openVtySession();
      this.registerTearDown(() => {
        const s = this.vty;
        if (s && device instanceof Router) device.closeVtySession(s);
        this.vty = null;
      });
    }
  }

  getSessionType(): SessionType { return 'cisco'; }
  getTheme(): TerminalTheme { return CISCO_THEME; }

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
    if (this.vty && dev instanceof Router) {
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

  /**
   * Override updatePrompt to read the prompt from the vty's swapped-in
   * shell state, not from the device's shared default state.
   */
  override updatePrompt(): void {
    const dev = this.device;
    if (this.vty && dev instanceof Router) {
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

  private debugJob: AsyncJobHandle | null = null;
  private debugUnsubscribe: (() => void) | null = null;

  protected override afterCommandExecuted(_command: string): void {
    const svc = (this.device as unknown as { getDebugService?: () => TerminalDebugSource }).getDebugService?.();
    if (!svc) return;
    if (svc.hasAnyFlag() && !this.debugJob) {
      this.startDebugSubscription(svc);
    } else if (!svc.hasAnyFlag() && this.debugJob) {
      this.debugJob.cancel();
      this.debugJob = null;
    }
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

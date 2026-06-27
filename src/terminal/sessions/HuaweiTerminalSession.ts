/**
 * HuaweiTerminalSession — Huawei VRP terminal model.
 *
 * Defines which Huawei VRP commands require interactive prompts
 * (save configuration, reset saved-configuration, reboot, etc.)
 * via buildInteractiveFlow() → InteractiveFlowEngine.
 */

import type { ICLIDevice } from '@/network';
import { CLITerminalSession } from './CLITerminalSession';
import { TerminalTheme, SessionType, withTimeout, DeviceOfflineError } from './TerminalSession';
import { HuaweiFlowBuilder } from '@/terminal/flows/HuaweiFlowBuilder';
import type { InteractiveStep } from '@/terminal/core/types';
import { Router } from '@/network/devices/Router';
import type { CliShellSession } from '@/network/devices/shells/vty/CliShellSession';
import type { AsyncJobHandle } from '@/terminal/async';
import type { TerminalDebugSource } from '@/network/devices/diag/DebugBroadcast';
import type { LoggingMonitorSource } from '@/network/devices/inspection/config/LoggingConfig';

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
  /** Per-terminal vty session — same model as CiscoTerminalSession (§5.1). */
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

  getSessionType(): SessionType { return 'huawei'; }
  getTheme(): TerminalTheme { return HUAWEI_THEME; }

  protected override prepareAsRemoteUser(_user: string): void {
    if (this.vty) {
      this.vty.state.privilegeLevel = 15;
    }
    this.isBooting = false;
    this.updatePrompt();
  }

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

  override updatePrompt(): void {
    const dev = this.device;
    if (this.vty && dev instanceof Router) {
      this.prompt = dev.getPromptForVty(this.vty);
    } else {
      this.prompt = this.cliDevice.getPrompt();
    }
    this.notify();
  }

  /**
   * Effective `screen-length` of this vty (terminal_gap.md §5.3).
   * `screen-length 0` / `screen-length disable` returns 0 → pager off.
   */
  protected override getPageSize(): number {
    return this.vty?.state.terminalLength ?? 24;
  }

  protected getDefaultPrompt(): string {
    return `<${this.device.getHostname()}>`;
  }

  protected getCtrlZCommand(): string { return 'return'; }
  protected getPagerIndicator(): string { return '  ---- More ----'; }

  protected isTopLevelExit(line: string): boolean {
    const w = line.trim().toLowerCase();
    return w === 'quit' || w === 'logout';
  }

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

  /**
   * Huawei VRP interactive commands:
   * - save → asks Are you sure to continue? [Y/N]
   * - reset saved-configuration → warns and asks [Y/N]
   * - reboot → confirms reboot [Y/N]
   */
  protected buildInteractiveFlow(command: string): InteractiveStep[] | null {
    const lower = command.toLowerCase().trim();

    if (lower === 'save') {
      return HuaweiFlowBuilder.saveConfiguration();
    }

    if (lower === 'reset saved-configuration') {
      return HuaweiFlowBuilder.resetSavedConfiguration();
    }

    if (lower === 'reboot') {
      return HuaweiFlowBuilder.rebootConfirmation();
    }

    return null;
  }

  private debugJob: AsyncJobHandle | null = null;
  private debugUnsubscribe: (() => void) | null = null;
  private monitorJob: AsyncJobHandle | null = null;
  private monitorUnsubscribe: (() => void) | null = null;

  protected override afterCommandExecuted(_command: string): void {
    this.reconcileDebugSubscription();
    this.reconcileTerminalMonitor();
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

  private reconcileDebugSubscription(): void {
    const svc = (this.device as unknown as { getDebugService?: () => TerminalDebugSource }).getDebugService?.();
    if (!svc) return;
    const wantSubscription = svc.hasAnyFlag() && (this.vty?.state.terminalDebugging ?? false);
    if (wantSubscription && !this.debugJob) {
      this.startDebugSubscription(svc);
    } else if (!wantSubscription && this.debugJob) {
      this.debugJob.cancel();
      this.debugJob = null;
    }
  }

  private startDebugSubscription(svc: TerminalDebugSource): void {
    this.debugJob = this.startAsyncCommand({
      mode: 'background',
      kind: 'subscription',
      command: 'terminal debugging',
      label: 'VRP debug output',
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

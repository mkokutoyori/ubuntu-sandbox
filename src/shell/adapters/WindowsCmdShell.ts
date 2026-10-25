/**
 * WindowsCmdShell — concrete shell that runs cmd.exe on a Windows box.
 *
 * Adapter over WindowsPC's command dispatch. Recognises the launchers
 * cmd.exe itself special-cases (`powershell`, `pwsh`) and hands off to
 * the appropriate child shell — so a `powershell` typed at a remote
 * Windows machine over SSH correctly lands the user in PowerShell,
 * just like at a physical console.
 */

import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { ShellFactory } from '../ShellFactory';
import { NestedSshLogin } from '../NestedSshLogin';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { leaseWindowsSession, returnWindowsSession } from './WindowsShellSessionLease';

export interface WindowsCmdShellOptions extends AbstractShellOptions {
  readonly forkFrom?: WindowsShellSession | null;
}

interface WindowsDevice {
  executeCommand(cmd: string): Promise<string>;
  executeCommandInSession?(cmd: string, s: WindowsShellSession): Promise<string>;
  lastNativeExitCode?(output: string): number;
}

const CMD_EXIT_WITH_CODE = /^exit(?:\s+\/b)?\s+(-?\d+)$/i;

const CHILD_LAUNCHERS: Readonly<Record<string, 'cmd' | 'powershell' | 'pwsh'>> = {
  cmd: 'cmd', 'cmd.exe': 'cmd',
  powershell: 'powershell', 'powershell.exe': 'powershell',
  pwsh: 'pwsh', 'pwsh.exe': 'pwsh',
};

/** Canonical cmd.exe activation banner — matches the real CLI banner. */
const CMD_BANNER: readonly string[] = [
  'Microsoft Windows [Version 10.0.22631.6649]',
  '(c) Microsoft Corporation. All rights reserved.',
];

export class WindowsCmdShell extends AbstractShell {
  readonly kind = 'cmd';

  private readonly windowsSession: WindowsShellSession | null;
  private readonly nestedSsh = new NestedSshLogin();

  /** Real cmd.exe only knows `cls`; typing `clear` produces a "not
   *  recognized as an internal or external command" error. */
  protected override clearWords: ReadonlySet<string> = new Set(['cls']);

  protected override eofEndsSession = false;

  constructor(opts: WindowsCmdShellOptions) {
    super(opts);
    this.windowsSession = leaseWindowsSession({
      device: opts.device, user: opts.user, directory: opts.context.cwd, forkFrom: opts.forkFrom,
    });
  }

  protected override onDispose(): void {
    returnWindowsSession(this.device, this.windowsSession);
  }

  getPrompt(): string {
    if (this.windowsSession && this.device instanceof WindowsPC) {
      return this.device.commandPrompt(this.windowsSession);
    }
    const cwd = this.windowsSession?.cwd
      ?? (this.context.cwd && this.context.cwd.length > 0 ? this.context.cwd : null)
      ?? `C:\\Users\\${this.user}`;
    return `${cwd}>`;
  }

  override getActivationBanner(): readonly string[] {
    return CMD_BANNER;
  }

  override getDeactivationBanner(): readonly string[] {
    return []; // cmd's `exit` is silent.
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    // ssh launch intercept — lets the user chain SSH from a remote cmd.
    const ssh = await this.nestedSsh.launch(line, {
      defaultUser: this.user,
      sourceIp: firstConfiguredIpCmd(this.device),
      sourceDevice: this.device,
      sourceHostname: (this.device as unknown as { getHostname?: () => string }).getHostname?.(),
    }, this.input);
    if (ssh) return ssh;

    const lower = line.trim().toLowerCase();
    const exitWithCode = CMD_EXIT_WITH_CODE.exec(line.trim());
    if (exitWithCode) return { output: [], exit: true, exitCode: Number.parseInt(exitWithCode[1], 10) & 0xff };
    const launched = CHILD_LAUNCHERS[lower];
    if (launched) {
      const child = ShellFactory.tryCreateChild(launched, {
        device: this.device,
        user: this.user,
        parent: this,
        cwd: this.windowsSession?.cwd,
        extras: { forkFrom: this.windowsSession },
      });
      if (child) return { output: [], childShell: child };
    }

    const dev = this.device as unknown as WindowsDevice;
    if (this.windowsSession) {
      this.windowsSession.inputReader = (prompt, preceding) => {
        if (preceding !== undefined) for (const text of preceding.split('\n')) this.input.emit(text);
        return this.input.ask(prompt);
      };
    }
    // Use the per-session dispatch when a session is bound so `cd` /
    // `set` mutate THIS terminal's state, not the device-wide globals.
    const raw = (this.windowsSession && this.device instanceof WindowsPC
      && dev.executeCommandInSession)
      ? await dev.executeCommandInSession(line, this.windowsSession)
      : await dev.executeCommand(line);
    return { output: this.splitOutput(raw), exitCode: dev.lastNativeExitCode?.(raw) };
  }

  private splitOutput(s: string): string[] {
    if (s === '' || s == null) return [];
    return s.replace(/\n+$/, '').split('\n');
  }

  async handleInput(value: string): Promise<ShellLineResult> {
    return this.nestedSsh.answer(value);
  }
}

function firstConfiguredIpCmd(dev: unknown): string | undefined {
  const ports = (dev as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
  if (!ports) return undefined;
  for (const port of ports.values()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}

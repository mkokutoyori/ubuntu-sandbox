/**
 * WindowsPowerShellShell — Concrete shell that runs PowerShell on a
 * Windows machine.
 *
 * The simulator already has a fully-featured PowerShellSubShell, but
 * it is welded to the LOCAL terminal stack. This adapter exposes the
 * same engine through the new IShell contract so SSH can push a real
 * PowerShell against a remote Windows device — no banner-and-close
 * placeholder.
 *
 * For now we reuse PowerShellSubShell as the backing engine and wrap
 * its `processLine` output; once Phase 1B migrates all sessions to the
 * new layer, the legacy sub-shell will be deleted and this class will
 * embed the PowerShellExecutor / PSInterpreter directly.
 */

import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import type { RichOutputLine, LineType } from '@/terminal/core/types';
import { styleWindowsOutput } from '@/terminal/core/windowsOutputStyle';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { powershellInputIsIncomplete } from '@/powershell/lexer/PSInputCompleteness';
import { WindowsPC } from '@/network/devices/WindowsPC';
import type { WindowsShellSession } from '@/network/devices/windows/shell/WindowsShellSession';
import { ShellFactory } from '../ShellFactory';
import { NestedSshLogin } from '../NestedSshLogin';
export interface WindowsPowerShellOptions extends AbstractShellOptions {
  /** Per-terminal cmd.exe session for cwd / env / drive-cwd isolation. */
  readonly windowsSession?: WindowsShellSession | null;
  /** 'core' starts PowerShell 7 (pwsh); the default is Windows PowerShell 5.1. */
  readonly language?: 'desktop' | 'core';
}

export class WindowsPowerShellShell extends AbstractShell {
  readonly kind = 'powershell';
  protected override eofEndsSession = false;
  protected override passesTypedLines = true;

  private subShell: PowerShellSubShell;
  private banner: readonly string[];
  private readonly windowsSession: WindowsShellSession | null;
  /** True when this shell owns the WindowsShellSession (allocated it
   *  itself, typical of SSH-pushed PS) and must close it on dispose. */
  private readonly ownsSession: boolean;
  private readonly nestedSsh = new NestedSshLogin();

  /** PowerShell exposes BOTH `clear` and `cls` as aliases of Clear-Host. */
  protected override clearWords: ReadonlySet<string> = new Set(['clear', 'cls', 'clear-host']);

  constructor(opts: WindowsPowerShellOptions) {
    super(opts);
    if (opts.windowsSession) {
      this.windowsSession = opts.windowsSession;
      this.ownsSession = false;
    } else if (opts.device instanceof WindowsPC) {
      // No session supplied (typical SSH push): allocate one bound to
      // the SSH user's home so PS commands operate on the right cwd
      // instead of leaking C:\\Users\\User across foreign SSH sessions.
      this.windowsSession = opts.device.openShellSession({
        user: opts.user,
        cwd: opts.context.cwd && opts.context.cwd.length > 0
          ? opts.context.cwd
          : `C:\\Users\\${opts.user}`,
      });
      this.ownsSession = true;
    } else {
      this.windowsSession = null;
      this.ownsSession = false;
    }
    const { subShell, banner } = PowerShellSubShell.create(opts.device, {
      initialCwd: opts.context.cwd,
      // Pass the (possibly freshly-allocated) per-shell session so PS
      // commands operate on the SSH user's tree, not the global cwd.
      session: this.windowsSession,
      language: opts.language,
    });
    this.subShell = subShell;
    this.banner = banner;
  }

  override setInputHost(host: import('@/shell/input').InputHost): void {
    super.setInputHost(host);
    this.subShell.setInputHost?.(host);
  }

  getPrompt(): string {
    return this.subShell.getPrompt();
  }

  protected override awaitsMoreInput(): boolean {
    return this.subShell.awaitsMoreInput();
  }

  override getActivationBanner(): readonly string[] {
    return this.banner;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    if (this.subShell.awaitsMoreInput() || powershellInputIsIncomplete(line)) {
      return this.runInSubShell(line);
    }
    const ssh = await this.nestedSsh.launch(line, {
      defaultUser: this.user,
      sourceIp: firstConfiguredIpPs(this.device),
      sourceDevice: this.device,
      sourceHostname: (this.device as unknown as { getHostname?: () => string }).getHostname?.(),
    }, this.input);
    if (ssh) return ssh;

    const lower = line.trim().toLowerCase();
    if (lower === 'cmd' || lower === 'cmd.exe') {
      const child = ShellFactory.tryCreateChild('cmd', {
        device: this.device,
        user: this.user,
        parent: this,
        cwd: this.windowsSession?.cwd ?? this.context.cwd,
        extras: { windowsSession: this.windowsSession ?? null },
      });
      if (child) return { output: [], childShell: child };
    }
    return this.runInSubShell(line);
  }

  private async runInSubShell(line: string): Promise<ShellLineResult> {
    const r = await this.subShell.processLine(line);
    return {
      output: r.output ?? [],
      exit: r.exit,
      clearScreen: r.clearScreen,
    };
  }

  protected override synthesizeStyledOutput(
    output: readonly string[],
    lineType: LineType = 'output',
  ): RichOutputLine[] {
    if (lineType !== 'output') return super.synthesizeStyledOutput(output, lineType);
    return styleWindowsOutput(output);
  }

  override getCompletions(line: string): readonly string[] {
    return this.subShell.getCompletions?.(line) ?? [];
  }

  completionStart(line: string): number | null {
    return this.subShell.completionStart?.(line) ?? null;
  }

  protected override onDispose(): void {
    this.subShell.dispose();
    if (this.windowsSession && this.ownsSession
        && this.device instanceof WindowsPC) {
      this.device.closeShellSession(this.windowsSession);
    }
  }

  async handleInput(value: string): Promise<ShellLineResult> {
    return this.nestedSsh.answer(value);
  }
}

/** Sanity guard — surfaces a clear error if someone tries to spawn PS
 *  on a non-Windows device, instead of producing nonsense later. */
export function assertPowerShellTarget(device: unknown): asserts device is WindowsPC {
  if (!(device instanceof WindowsPC)) {
    throw new Error('PowerShell can only run on a WindowsPC device');
  }
}

function firstConfiguredIpPs(dev: unknown): string | undefined {
  const ports = (dev as { ports?: Map<string, { getIPAddress: () => { toString(): string } | null }> }).ports;
  if (!ports) return undefined;
  for (const port of ports.values()) {
    const ip = port.getIPAddress?.();
    if (ip) return ip.toString();
  }
  return undefined;
}

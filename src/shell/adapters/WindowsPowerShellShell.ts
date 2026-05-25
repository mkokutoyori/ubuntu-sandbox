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
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';

export class WindowsPowerShellShell extends AbstractShell {
  readonly kind = 'powershell';

  private subShell: PowerShellSubShell;
  private banner: readonly string[];

  constructor(opts: AbstractShellOptions) {
    super(opts);
    const { subShell, banner } = PowerShellSubShell.create(opts.device, {
      initialCwd: opts.context.cwd,
      // The legacy sub-shell wants a WindowsShellSession for cwd
      // isolation; when SSH'd in from another machine we don't have one
      // and the device-wide cwd is acceptable for now.
      session: null,
    });
    this.subShell = subShell;
    this.banner = banner;
  }

  getPrompt(): string {
    return this.subShell.getPrompt();
  }

  override getActivationBanner(): readonly string[] {
    return this.banner;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    const r = await this.subShell.processLine(line);
    return {
      output: r.output ?? [],
      exit: r.exit,
      clearScreen: r.clearScreen,
    };
  }

  override getCompletions(line: string): readonly string[] {
    return this.subShell.getCompletions?.(line) ?? [];
  }

  protected override onDispose(): void {
    this.subShell.dispose();
  }
}

/** Sanity guard — surfaces a clear error if someone tries to spawn PS
 *  on a non-Windows device, instead of producing nonsense later. */
export function assertPowerShellTarget(device: unknown): asserts device is WindowsPC {
  if (!(device instanceof WindowsPC)) {
    throw new Error('PowerShell can only run on a WindowsPC device');
  }
}

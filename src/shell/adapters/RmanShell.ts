import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { ReactiveRmanSubShell } from '@/terminal/subshells/rman/ReactiveRmanSubShell';

export class RmanShell extends AbstractShell {
  readonly kind = 'rman';

  private subShell: ReactiveRmanSubShell | null = null;
  private banner: readonly string[] = [];

  constructor(opts: AbstractShellOptions & { launchLine?: string }) {
    super(opts);
    const args = (opts.launchLine ?? 'rman').trim().split(/\s+/).slice(1);
    try {
      const created = ReactiveRmanSubShell.create(opts.device, args);
      this.subShell = created.subShell;
      this.banner = created.banner;
    } catch {
      /* device without RMAN — isReady remains false */
    }
  }

  get isReady(): boolean { return this.subShell !== null; }

  getPrompt(): string {
    return this.subShell?.getPrompt() ?? 'RMAN> ';
  }

  override getActivationBanner(): readonly string[] { return this.banner; }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    if (!this.subShell) {
      return { output: ['rman: not available on this device'], exit: true };
    }
    const r = await this.subShell.processLine(line);
    return {
      output: r.output ?? [],
      exit: r.exit,
      clearScreen: r.clearScreen,
    };
  }

  override getCompletions(line: string): readonly string[] {
    return this.subShell?.getCompletions?.(line) ?? [];
  }

  protected override onDispose(): void { this.subShell?.dispose(); }
}

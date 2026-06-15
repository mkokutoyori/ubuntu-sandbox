/**
 * SqlPlusShell — concrete shell for the Oracle SQL*Plus REPL.
 *
 * Like {@link WindowsPowerShellShell}, this adapter currently delegates
 * to the legacy SqlPlusSubShell so the new layer can be introduced
 * without rewriting the SQL engine. It works against any device whose
 * `executeCommand('sqlplus …')` boots the engine — i.e. a LinuxServer
 * carrying Oracle.
 */

import { AbstractShell, type AbstractShellOptions } from '../AbstractShell';
import type { ShellLineResult } from '../IShell';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

export class SqlPlusShell extends AbstractShell {
  readonly kind = 'sqlplus';

  private subShell: SqlPlusSubShell | null = null;
  private banner: readonly string[] = [];

  constructor(opts: AbstractShellOptions & { launchLine?: string }) {
    super(opts);
    // Tokenise the launch line (e.g. `sqlplus / as sysdba`) into the
    // argv the SQL*Plus engine expects (after stripping the verb).
    const args = (opts.launchLine ?? 'sqlplus').trim().split(/\s+/).slice(1);
    try {
      const created = SqlPlusSubShell.create(opts.device, args, opts.user);
      this.subShell = created.subShell;
      this.banner = [...created.banner, ...created.loginOutput];
    } catch {
      // Oracle FS not provisioned on this device — leave isReady false.
    }
  }

  /** True when the underlying engine accepted the launch (Oracle present). */
  get isReady(): boolean { return this.subShell !== null; }

  getPrompt(): string {
    return this.subShell?.getPrompt() ?? 'SQL> ';
  }

  override getActivationBanner(): readonly string[] {
    return this.banner;
  }

  protected async dispatch(line: string): Promise<ShellLineResult> {
    if (!this.subShell) {
      return { output: ['sqlplus: not available on this device'], exit: true };
    }
    const r = await this.subShell.processLine(line);
    return {
      output: r.output ?? [],
      exit: r.exit,
      clearScreen: r.clearScreen,
    };
  }

  protected override onDispose(): void { this.subShell?.dispose(); }
}

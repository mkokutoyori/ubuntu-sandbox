import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { BackupSet } from '../catalog/types';
import type { IRmanCommand, RmanCommandContext } from './types';

export type SwitchScope = 'DATABASE' | 'TABLESPACE' | 'DATAFILE';

export class SwitchCommand implements IRmanCommand<string[]> {
  readonly name = 'SWITCH';
  constructor(private readonly scope: SwitchScope) {}

  execute(args: string[], { ctx, catalog }: RmanCommandContext): Result<string[], RmanError> {
    if (ctx.runSqlStatement === undefined) {
      return err({ code: 'RMAN_01009', message: 'SWITCH is not available on this host' });
    }
    if (this.scope === 'DATABASE' && ctx.getInstanceState?.() === 'OPEN') {
      return err({ code: 'RMAN_06403', message: 'database must be mounted, not open, to switch to copies' });
    }
    const files = this.targets(args[0], ctx.getDatafiles());
    if (files.length === 0) {
      return err({ code: 'RMAN_01009', message: `SWITCH ${this.scope}: no matching datafile` });
    }
    const snapshot = catalog.listAll();
    if (snapshot.ok === false) return snapshot;
    const lines: string[] = [''];
    for (const file of files) {
      const copy = this.latestCopy(snapshot.value.sets, file.fileNo);
      if (copy === undefined) {
        return err({ code: 'RMAN_06571', message: `datafile ${file.fileNo} does not have recoverable copy` });
      }
      const copyPath = copy.pieces[0].path;
      const renamed = ctx.runSqlStatement(`ALTER DATABASE RENAME FILE '${file.path}' TO '${copyPath}'`);
      if (renamed.ok === false) return err({ code: 'RMAN_01009', message: renamed.error });
      const deleted = catalog.deleteBackupSet(copy.bsKey);
      if (deleted.ok === false) return deleted;
      lines.push(`datafile ${file.fileNo} switched to datafile copy "${copyPath}"`);
    }
    lines.push('');
    return ok(lines);
  }

  private targets(argument: string | undefined, datafiles: ReadonlyArray<{ fileNo: number; path: string; tablespace: string }>) {
    if (this.scope === 'DATABASE') return datafiles;
    if (this.scope === 'DATAFILE') return datafiles.filter(file => file.fileNo === Number(argument));
    return datafiles.filter(file => file.tablespace.toUpperCase() === (argument ?? '').toUpperCase());
  }

  private latestCopy(sets: readonly BackupSet[], fileNo: number): BackupSet | undefined {
    return sets
      .filter(set => set.type === 'DATAFILECOPY' && set.datafiles.some(entry => entry.fileNo === fileNo)
        && set.pieces[0]?.status === 'AVAILABLE')
      .sort((a, b) => b.bsKey - a.bsKey)[0];
  }
}

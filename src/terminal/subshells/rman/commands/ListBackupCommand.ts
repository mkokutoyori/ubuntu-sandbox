/**
 * ListBackupCommand — synchronous read from the catalog.
 *
 * Returns either the SUMMARY view (one row per set) or the detailed
 * view (set + pieces + datafiles).
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import type { BackupSet } from '../catalog/types';
import { formatOracleDate, formatSize, formatElapsed } from '../core/pureUtils';

export class ListBackupCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST BACKUP';
  constructor(private readonly variant: 'SUMMARY' | 'DETAIL' = 'DETAIL') {}

  execute(_args: string[], { catalog }: RmanCommandContext): Result<string[], RmanError> {
    const snap = catalog.listAll();
    if (!snap.ok) return snap;
    const { sets } = snap.value;
    if (sets.length === 0) {
      return ok(['', 'List of Backups', '===============', 'no backup found in the repository', '']);
    }
    return ok(this.variant === 'SUMMARY' ? this._summary(sets) : this._detail(sets));
  }

  private _summary(sets: ReadonlyArray<BackupSet>): string[] {
    const lines: string[] = [
      '',
      'List of Backups',
      '===============',
      'Key     TY LV S Device Type Completion Time     #Pieces #Copies Compressed Tag',
      '------- -- -- - ----------- ------------------- ------- ------- ---------- ---',
    ];
    for (const s of sets) {
      const ts = formatOracleDate(new Date(s.completionTime));
      lines.push(`${String(s.bsKey).padEnd(7)} B  F  A DISK        ${ts}  1       1       NO         ${s.tag.label}`);
    }
    lines.push('');
    return lines;
  }

  private _detail(sets: ReadonlyArray<BackupSet>): string[] {
    const lines: string[] = ['', 'List of Backup Sets', '===================', ''];
    lines.push(
      'BS Key  Type LV Size       Device Type Elapsed Time Completion Time',
      '------- ---- -- ---------- ----------- ------------ ---------------',
    );
    for (const s of sets) {
      const ts = formatOracleDate(new Date(s.completionTime));
      const elapsed = formatElapsed(s.completionTime - s.startTime);
      const size = formatSize(s.sizeBytes);
      lines.push(`${String(s.bsKey).padEnd(7)} Full    ${size.padEnd(10)} DISK        ${elapsed}     ${ts}`);
      for (const p of s.pieces) {
        lines.push(`        BP Key: ${p.key.bpKey}   Status: ${p.status}  Compressed: NO  Tag: ${p.tag.label}`);
        lines.push(`          Piece Name: ${p.path}`);
      }
      if (s.datafiles.length > 0) {
        lines.push(`  List of Datafiles in backup set ${s.bsKey}`);
        lines.push('  File LV Type Ckp SCN    Ckp Time        Name');
        lines.push('  ---- -- ---- ---------- --------------- ----');
        for (const df of s.datafiles) {
          const dfTs = formatOracleDate(new Date(df.ckpTime));
          lines.push(`  ${String(df.fileNo).padStart(4)}    Full ${String(df.ckpScn.value).padEnd(10)} ${dfTs}  ${df.path}`);
        }
      }
    }
    lines.push('');
    return lines;
  }
}

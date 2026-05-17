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

/** Render the LV column (TY column already always 'B' for backupset). */
function lvCode(s: BackupSet): string {
  switch (s.type) {
    case 'FULL':           return 'F';
    case 'INCREMENTAL_0':  return '0';
    case 'INCREMENTAL_1':  return '1';
    case 'ARCHIVELOG':     return 'A';
    case 'CONTROLFILE':    return 'F';
    case 'DATAFILECOPY':   return 'F';
  }
}

/** Render the Type column in detail view. */
function typeOf(s: BackupSet): string {
  switch (s.type) {
    case 'FULL':           return 'Full';
    case 'INCREMENTAL_0':  return 'Incr-0';
    case 'INCREMENTAL_1':  return 'Incr-1';
    case 'ARCHIVELOG':     return 'ArchLog';
    case 'CONTROLFILE':    return 'Ctrl';
    case 'DATAFILECOPY':   return 'DFCopy';
  }
}

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
      const lv = lvCode(s);
      lines.push(`${String(s.bsKey).padEnd(7)} B  ${lv}  A DISK        ${ts}  1       1       NO         ${s.tag.label}`);
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
      const typeLabel = typeOf(s).padEnd(7);
      lines.push(`${String(s.bsKey).padEnd(7)} ${typeLabel} ${size.padEnd(10)} DISK        ${elapsed}     ${ts}`);
      for (const p of s.pieces) {
        lines.push(`        BP Key: ${p.key.bpKey}   Status: ${p.status}  Compressed: NO  Tag: ${p.tag.label}`);
        lines.push(`          Piece Name: ${p.path}`);
      }
      if (s.type === 'CONTROLFILE') {
        lines.push('  Control File Included: Ckp SCN: 1892354    Ckp time: ' +
          formatOracleDate(new Date(s.completionTime)));
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

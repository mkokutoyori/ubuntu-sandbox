/**
 * ReportCommand — REPORT SCHEMA / REPORT NEED BACKUP.
 *
 * Synchronous read from IRmanOracleContext (datafile list) and catalog.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class ReportCommand implements IRmanCommand<string[]> {
  readonly name = 'REPORT';
  constructor(private readonly mode: 'SCHEMA' | 'NEED_BACKUP' | 'OBSOLETE' | 'UNRECOVERABLE') {}

  execute(_args: string[], { ctx, catalog, policy }: RmanCommandContext): Result<string[], RmanError> {
    if (this.mode === 'OBSOLETE') {
      const snap = catalog.listAll();
      if (!snap.ok) return snap;
      const obsolete = policy.findObsolete(snap.value.sets);
      const lines = [
        '',
        'RMAN retention policy will be applied to the command',
        `RMAN retention policy is set to ${policy.describe().toLowerCase()}`,
        'Report of obsolete backups and copies',
        'Type                 Key    Completion Time    Filename/Handle',
        '-------------------- ------ ------------------ --------------------',
      ];
      for (const s of obsolete) {
        const ts = new Date(s.completionTime).toISOString();
        for (const p of s.pieces) {
          lines.push(`Backup Set           ${String(s.bsKey).padEnd(6)} ${ts}  ${p.path}`);
        }
      }
      if (obsolete.length === 0) lines.push('no obsolete backups found');
      lines.push('');
      return ok(lines);
    }
    if (this.mode === 'UNRECOVERABLE') {
      // A datafile is "unrecoverable" if it has been touched with NOLOGGING
      // since its last backup. The simulator has no NOLOGGING tracking, so
      // the report is always empty.
      return ok([
        '',
        'Report of files that need backup due to unrecoverable operations',
        'File Type of Backup Required Name',
        '---- ----------------------- -----------------------------------',
        'no files require backup due to unrecoverable operations',
        '',
      ]);
    }
    if (this.mode === 'SCHEMA') {
      const lines: string[] = [
        '',
        `Report of database schema for database with db_unique_name ${ctx.dbName}`,
        '',
        'List of Permanent Datafiles',
        '===========================',
        'File Size(MB) Tablespace           RB segs Datafile Name',
        '---- -------- -------------------- ------- ------------------------',
      ];
      for (const df of ctx.getDatafiles()) {
        const sizeMB = Math.round(df.sizeBytes / 1_048_576).toString().padEnd(8);
        const ts = df.tablespace.padEnd(20);
        const rb = df.tablespace.startsWith('UNDO') || df.tablespace === 'SYSTEM' ? 'YES    ' : 'NO     ';
        lines.push(`${String(df.fileNo).padEnd(4)} ${sizeMB} ${ts} ${rb} ${df.path}`);
      }
      lines.push('', 'List of Temporary Files', '=======================',
        'File Size(MB) Tablespace           Maxsize(MB) Tempfile Name',
        '---- -------- -------------------- ----------- --------------------',
        '1    100      TEMP                 32768       /u01/app/oracle/oradata/ORCL/temp01.dbf',
        '');
      return ok(lines);
    }
    // NEED_BACKUP: a file is "in need" when no backup covers it
    const snap = catalog.listAll();
    if (!snap.ok) return snap;
    const covered = new Set<number>();
    for (const s of snap.value.sets) for (const df of s.datafiles) covered.add(df.fileNo);

    const lines = [
      '',
      'RMAN retention policy will be applied to the command',
      `RMAN retention policy is set to ${policy.describe().toLowerCase()}`,
      'Report of files with 0 redundant backups',
      'File #backs Name',
      '----- ------ ---------------------------------------------------',
    ];
    for (const df of ctx.getDatafiles()) {
      if (covered.has(df.fileNo)) continue;
      lines.push(`${String(df.fileNo).padEnd(5)} 0      ${df.path}`);
    }
    lines.push('');
    return ok(lines);
  }
}

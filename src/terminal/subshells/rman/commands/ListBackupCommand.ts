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
import { formatOracleDate } from '../core/pureUtils';
import { backupSetLines } from '../core/backupSetReport';
import { renderTable, type TableColumn, type TableStyle } from '@/network/devices/shells/cli/TextTable';

const RMAN_TABLE: TableStyle = { gap: 1, rule: true };

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

export type ListVariant = 'SUMMARY' | 'DETAIL' | 'ARCHIVELOG' | 'EXPIRED' | 'OBSOLETE' | 'COPY' | 'INCARNATION';

export class ListBackupCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST BACKUP';
  constructor(private readonly variant: ListVariant = 'DETAIL') {}

  execute(_args: string[], { catalog, policy, ctx }: RmanCommandContext): Result<string[], RmanError> {
    if (this.variant === 'INCARNATION') {
      const rows = [
        {
          incKey: 1, status: 'PARENT', resetScn: 1,
          resetTime: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
        },
        {
          incKey: 2, status: 'CURRENT', resetScn: 1_892_354,
          resetTime: new Date().toISOString().slice(0, 10),
        },
      ];
      const columns: ReadonlyArray<TableColumn<typeof rows[number]>> = [
        { header: 'DB Key',     width: 7,  value: () => '1' },
        { header: 'Inc Key',    width: 7,  value: row => String(row.incKey) },
        { header: 'DB Name',    width: 8,  value: () => ctx.dbName },
        { header: 'DB ID',      width: 16, value: () => String(ctx.dbId.value) },
        { header: 'STATUS',     width: 7,  value: row => row.status },
        { header: 'Reset SCN',  width: 10, value: row => String(row.resetScn) },
        { header: 'Reset Time',            value: row => row.resetTime },
      ];
      return ok(['', 'List of Database Incarnations', '=============================',
        ...renderTable(rows, columns, RMAN_TABLE), '']);
    }
    const snap = catalog.listAll();
    if (snap.ok === false) return snap;

    if (this.variant === 'ARCHIVELOG') {
      const arc = snap.value.sets.filter(s => s.type === 'ARCHIVELOG');
      if (arc.length === 0) return ok(['', 'no archived log found', '']);
      return ok(this._detail(arc));
    }
    if (this.variant === 'EXPIRED') {
      const expired = snap.value.pieces.filter(p => p.status === 'EXPIRED');
      if (expired.length === 0) return ok(['', 'no expired backups', '']);
      const lines = ['', 'List of Expired Backups', '======================='];
      for (const p of expired) lines.push(`  BP Key: ${p.key.bpKey}  Piece: ${p.path}`);
      lines.push('');
      return ok(lines);
    }
    if (this.variant === 'OBSOLETE') {
      const obsolete = policy.findObsolete(snap.value.sets);
      if (obsolete.length === 0) return ok(['', 'no obsolete backups found', '']);
      return ok(this._detail(obsolete));
    }
    if (this.variant === 'COPY') {
      const copies = snap.value.sets.filter(s => s.type === 'DATAFILECOPY');
      if (copies.length === 0) return ok(['', 'specification does not match any datafile copy', '']);
      const lines = ['', 'List of Datafile Copies', '======================='];
      for (const s of copies) {
        for (const p of s.pieces) lines.push(`  Key: ${s.bsKey}  Name: ${p.path}`);
      }
      lines.push('');
      return ok(lines);
    }

    const { sets } = snap.value;
    if (sets.length === 0) {
      return ok(['', 'List of Backups', '===============', 'no backup found in the repository', '']);
    }
    return ok(this.variant === 'SUMMARY' ? this._summary(sets) : this._detail(sets));
  }

  private _summary(sets: ReadonlyArray<BackupSet>): string[] {
    const columns: ReadonlyArray<TableColumn<BackupSet>> = [
      { header: 'Key',             width: 7,  value: set => String(set.bsKey) },
      { header: 'TY',              width: 2,  value: () => 'B' },
      { header: 'LV',              width: 2,  value: lvCode },
      { header: 'S',               width: 1,  value: () => 'A' },
      { header: 'Device Type',     width: 11, value: () => 'DISK' },
      { header: 'Completion Time', width: 20, value: set => formatOracleDate(new Date(set.completionTime)) },
      { header: '#Pieces',         width: 7,  value: set => String(set.pieces.length) },
      { header: '#Copies',         width: 7,  value: () => '1' },
      { header: 'Compressed',      width: 10, value: set => set.pieces.some(p => p.compressed) ? 'YES' : 'NO' },
      { header: 'Tag',                        value: set => set.tag.label },
    ];
    return ['', 'List of Backups', '===============',
      ...renderTable(sets, columns, RMAN_TABLE), ''];
  }

  private _detail(sets: ReadonlyArray<BackupSet>): string[] {
    return backupSetLines(sets);
  }
}

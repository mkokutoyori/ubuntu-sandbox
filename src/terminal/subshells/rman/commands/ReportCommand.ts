/**
 * ReportCommand — REPORT SCHEMA / NEED BACKUP / OBSOLETE / UNRECOVERABLE.
 *
 * Synchronous read from IRmanOracleContext (datafile list) and catalog.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import type { IRetentionPolicy } from '../policy/IRetentionPolicy';
import { RedundancyPolicy } from '../policy/RedundancyPolicy';
import { RecoveryWindowPolicy } from '../policy/RecoveryWindowPolicy';

/** Parse an optional REDUNDANCY n / RECOVERY WINDOW OF n DAYS suffix into a policy. */
function parsePolicySuffix(text: string, fallback: IRetentionPolicy): IRetentionPolicy {
  const r = text.match(/^REDUNDANCY\s+(\d+)$/i);
  if (r) return new RedundancyPolicy(parseInt(r[1], 10));
  const w = text.match(/^RECOVERY\s+WINDOW\s+OF\s+(\d+)\s+DAYS?$/i);
  if (w) return new RecoveryWindowPolicy(parseInt(w[1], 10));
  const d = text.match(/^DAYS\s+(\d+)$/i);
  if (d) return new RecoveryWindowPolicy(parseInt(d[1], 10));
  return fallback;
}

export class ReportCommand implements IRmanCommand<string[]> {
  readonly name = 'REPORT';
  constructor(private readonly mode: 'SCHEMA' | 'NEED_BACKUP' | 'OBSOLETE' | 'UNRECOVERABLE') {}

  execute(args: string[], { ctx, catalog, policy }: RmanCommandContext): Result<string[], RmanError> {
    const suffix = (args[0] ?? '').trim();
    const activePolicy = suffix ? parsePolicySuffix(suffix, policy) : policy;
    if (this.mode === 'OBSOLETE') {
      const snap = catalog.listAll();
      if (snap.ok === false) return snap;
      const obsolete = activePolicy.findObsolete(snap.value.sets);
      const lines = [
        '',
        'RMAN retention policy will be applied to the command',
        `RMAN retention policy is set to ${activePolicy.describe().toLowerCase()}`,
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
      const lines = [
        '',
        'Report of files that need backup due to unrecoverable operations',
        'File Type of Backup Required Name',
        '---- ----------------------- -----------------------------------',
      ];
      const touches = ctx.getUnrecoverableFiles?.() ?? [];
      for (const df of touches) {
        lines.push(`${String(df.fileNo).padEnd(4)} full or incremental     ${df.path}`);
      }
      if (touches.length === 0) {
        lines.push('no files require backup due to unrecoverable operations');
      }
      lines.push('');
      return ok(lines);
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
    // NEED_BACKUP — la politique DECIDE : sous REDUNDANCY n, un fichier
    // est en defaut tant qu'il porte MOINS de n sauvegardes ; sous une
    // fenetre de recuperation, tant qu'aucune sauvegarde ne precede son
    // bord, puisqu'il faut une sauvegarde d'AVANT pour y revenir.
    const snap = catalog.listAll();
    if (snap.ok === false) return snap;
    const comptes = new Map<number, number>();
    const plusAncienne = new Map<number, number>();
    for (const s of snap.value.sets) {
      if (s.type === 'ARCHIVELOG') continue;
      for (const df of s.datafiles) {
        comptes.set(df.fileNo, (comptes.get(df.fileNo) ?? 0) + 1);
        const connu = plusAncienne.get(df.fileNo);
        if (connu === undefined || s.completionTime < connu) {
          plusAncienne.set(df.fileNo, s.completionTime);
        }
      }
    }
    const fenetre = activePolicy.kind === 'recovery_window';
    const seuil = activePolicy.value ?? 1;
    const bord = Date.now() - seuil * 86_400_000;
    const lines = [
      '',
      'RMAN retention policy will be applied to the command',
      `RMAN retention policy is set to ${activePolicy.describe().toLowerCase()}`,
      fenetre
        ? `Report of files that must be backed up to satisfy ${seuil} days recovery window`
        : `Report of files with less than ${seuil} redundant backups`,
      fenetre
        ? 'File Days  Name'
        : 'File #bkps Name',
      '---- ----- -----------------------------------------------------',
    ];
    for (const df of ctx.getDatafiles()) {
      const nombre = comptes.get(df.fileNo) ?? 0;
      if (fenetre) {
        const ancienne = plusAncienne.get(df.fileNo);
        if (ancienne !== undefined && ancienne <= bord) continue;
        const jours = ancienne === undefined
          ? seuil
          : Math.floor((Date.now() - ancienne) / 86_400_000);
        lines.push(`${String(df.fileNo).padEnd(4)} ${String(jours).padEnd(5)} ${df.path}`);
        continue;
      }
      if (nombre >= seuil) continue;
      lines.push(`${String(df.fileNo).padEnd(4)} ${String(nombre).padEnd(5)} ${df.path}`);
    }
    lines.push('');
    return ok(lines);
  }
}

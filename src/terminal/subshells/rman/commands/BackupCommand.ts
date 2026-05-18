/**
 * BackupCommand — dispatches every BACKUP variant.
 *
 * Modes:
 *   - 'database'              BACKUP DATABASE
 *   - 'archivelog'            BACKUP ARCHIVELOG ALL
 *   - 'tablespace'            BACKUP TABLESPACE <name>
 *   - 'incremental'           BACKUP INCREMENTAL LEVEL 0|1 DATABASE
 *   - 'controlfile'           BACKUP CURRENT CONTROLFILE
 *   - 'validate'              BACKUP VALIDATE DATABASE
 *
 * Optional clauses (parsed from the post-keyword text):
 *   TAG '<x>'      → set the backup tag
 *   FORMAT '<y>'   → override the piece-file path template
 *   DELETE INPUT   → archivelog only: delete consumed archived logs
 */

import { type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export type BackupMode =
  | 'database' | 'archivelog' | 'tablespace' | 'incremental'
  | 'controlfile' | 'validate' | 'datafile' | 'spfile';

export class BackupCommand implements IRmanCommand<void> {
  readonly name = 'BACKUP';

  constructor(
    private readonly mode: BackupMode,
    private readonly forceCompressed = false,
    private readonly notBackedUpFromArg0 = false,
  ) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<void, RmanError> {
    const { engine } = cmdCtx;
    // Parse options against every captured fragment so trailing TAG / FORMAT /
    // DELETE INPUT / COMPRESSED / FROM SCN clauses are picked up regardless of
    // where the dispatcher pattern slotted them.
    const all = args.join(' ');
    const opts = parseBackupOptions(all);
    if (this.forceCompressed) opts.compressed = true;
    if (this.notBackedUpFromArg0) {
      const n = Number(args[0]);
      if (Number.isFinite(n)) opts.notBackedUpNTimes = n;
    }

    const plusArchivelog = /\bPLUS\s+ARCHIVELOG\b/i.test(all);

    let result: Result<void, RmanError>;
    switch (this.mode) {
      case 'database': {
        const r = engine.run(JobBuilder.backupDatabase(opts));
        if (!r.ok) return r;
        if (plusArchivelog) {
          const r2 = engine.run(JobBuilder.backupArchivelog({ deleteInput: opts.deleteInput }));
          if (!r2.ok) return r2;
        }
        result = r;
        break;
      }
      case 'archivelog':
        result = engine.run(JobBuilder.backupArchivelog(opts));
        break;
      case 'tablespace':
        result = engine.run(JobBuilder.backupTablespace(args[0] ?? 'USERS', opts));
        break;
      case 'incremental': {
        const level = (args[0] === '0' ? 0 : 1) as 0 | 1;
        // args[1] = "CUMULATIVE" if present, args[2] = post-clauses
        const cumulative = (args[1] ?? '').toUpperCase() === 'CUMULATIVE';
        const clauseOpts = parseBackupOptions(args.slice(1).join(' '));
        clauseOpts.cumulative = cumulative || clauseOpts.cumulative;
        result = engine.run(JobBuilder.backupIncremental(level, clauseOpts));
        break;
      }
      case 'controlfile':
        // Explicit BACKUP CURRENT CONTROLFILE — never re-triggers autobackup
        return engine.run(JobBuilder.backupControlfile(opts));
      case 'validate':
        return engine.run(JobBuilder.backupValidate());
      case 'datafile': {
        const n = Number(args[0]);
        result = engine.run(JobBuilder.backupDatafile(Number.isFinite(n) ? n : 1, opts));
        break;
      }
      case 'spfile':
        result = engine.run(JobBuilder.backupSpfile(opts));
        break;
    }

    // Controlfile autobackup — fires automatically after a successful
    // BACKUP DATABASE / TABLESPACE / DATAFILE / ARCHIVELOG / INCREMENTAL
    // when CONFIGURE CONTROLFILE AUTOBACKUP ON. Mirrors real Oracle's
    // behaviour. Self-trigger is guarded by `params.what === 'controlfile'`
    // so the autobackup doesn't recurse.
    if (result.ok && cmdCtx.config?.snapshot().controlfileAutobackup === true) {
      engine.run(JobBuilder.backupControlfile({ tag: 'AUTOBACKUP' }));
    }
    return result;
  }
}

/** Parse optional clauses from the trailing text of a BACKUP command. */
export function parseBackupOptions(text: string): {
  tag?: string; format?: string; deleteInput?: boolean;
  compressed?: boolean; fromScn?: number;
  keepForever?: boolean; keepUntilTime?: string;
  cumulative?: boolean; maxPieceSize?: number;
  encrypted?: boolean; notBackedUpNTimes?: number;
} {
  const out: {
    tag?: string; format?: string; deleteInput?: boolean;
    compressed?: boolean; fromScn?: number;
    keepForever?: boolean; keepUntilTime?: string;
    cumulative?: boolean; maxPieceSize?: number;
    encrypted?: boolean; notBackedUpNTimes?: number;
  } = {};
  const tagMatch = text.match(/\bTAG\s+'([^']+)'/i);
  if (tagMatch) out.tag = tagMatch[1].toUpperCase();
  const fmtMatch = text.match(/\bFORMAT\s+'([^']+)'/i);
  if (fmtMatch) out.format = fmtMatch[1];
  if (/\bDELETE\s+INPUT\b/i.test(text)) out.deleteInput = true;
  if (/\bCOMPRESSED\b/i.test(text))     out.compressed = true;
  const scnMatch = text.match(/\bFROM\s+SCN\s+(\d+)/i);
  if (scnMatch) out.fromScn = Number(scnMatch[1]);
  if (/\bKEEP\s+FOREVER\b/i.test(text)) out.keepForever = true;
  const keepUntil = text.match(/\bKEEP\s+UNTIL\s+TIME\s+'([^']+)'/i);
  if (keepUntil) out.keepUntilTime = keepUntil[1];
  if (/\bCUMULATIVE\b/i.test(text)) out.cumulative = true;
  if (/\bENCRYPTED\b/i.test(text))  out.encrypted = true;
  const notBackedUp = text.match(/\bNOT\s+BACKED\s+UP\s+(\d+)\s+TIMES\b/i);
  if (notBackedUp) out.notBackedUpNTimes = Number(notBackedUp[1]);
  const mps = text.match(/\bMAXPIECESIZE\s+(\d+)\s*([KMG])?/i);
  if (mps) {
    const mult = mps[2]?.toUpperCase() === 'G' ? 1_073_741_824
              : mps[2]?.toUpperCase() === 'M' ? 1_048_576
              : mps[2]?.toUpperCase() === 'K' ? 1024
              : 1;
    out.maxPieceSize = Number(mps[1]) * mult;
  }
  return out;
}

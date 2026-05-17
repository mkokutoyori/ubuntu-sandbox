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
  ) {}

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    // Parse options against every captured fragment so trailing TAG / FORMAT /
    // DELETE INPUT / COMPRESSED / FROM SCN clauses are picked up regardless of
    // where the dispatcher pattern slotted them.
    const all = args.join(' ');
    const opts = parseBackupOptions(all);
    if (this.forceCompressed) opts.compressed = true;

    const plusArchivelog = /\bPLUS\s+ARCHIVELOG\b/i.test(all);

    switch (this.mode) {
      case 'database': {
        const r = engine.run(JobBuilder.backupDatabase(opts));
        if (!r.ok) return r;
        if (plusArchivelog) {
          return engine.run(JobBuilder.backupArchivelog({ deleteInput: opts.deleteInput }));
        }
        return r;
      }
      case 'archivelog':
        return engine.run(JobBuilder.backupArchivelog(opts));
      case 'tablespace':
        return engine.run(JobBuilder.backupTablespace(args[0] ?? 'USERS', opts));
      case 'incremental': {
        const level = (args[0] === '0' ? 0 : 1) as 0 | 1;
        // args[1] would carry any post-clauses; reparse from there
        const clauseOpts = parseBackupOptions(args[1] ?? '');
        return engine.run(JobBuilder.backupIncremental(level, clauseOpts));
      }
      case 'controlfile':
        return engine.run(JobBuilder.backupControlfile(opts));
      case 'validate':
        return engine.run(JobBuilder.backupValidate());
      case 'datafile': {
        const n = Number(args[0]);
        return engine.run(JobBuilder.backupDatafile(Number.isFinite(n) ? n : 1, opts));
      }
      case 'spfile':
        return engine.run(JobBuilder.backupSpfile(opts));
    }
  }
}

/** Parse optional clauses from the trailing text of a BACKUP command. */
export function parseBackupOptions(text: string): {
  tag?: string; format?: string; deleteInput?: boolean;
  compressed?: boolean; fromScn?: number;
  keepForever?: boolean; keepUntilTime?: string;
} {
  const out: {
    tag?: string; format?: string; deleteInput?: boolean;
    compressed?: boolean; fromScn?: number;
    keepForever?: boolean; keepUntilTime?: string;
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
  return out;
}

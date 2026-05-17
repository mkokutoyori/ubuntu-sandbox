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

export type BackupMode = 'database' | 'archivelog' | 'tablespace' | 'incremental' | 'controlfile' | 'validate';

export class BackupCommand implements IRmanCommand<void> {
  readonly name = 'BACKUP';

  constructor(private readonly mode: BackupMode) {}

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    const captured = args[0] ?? '';
    const opts = parseBackupOptions(captured);

    const plusArchivelog = /\bPLUS\s+ARCHIVELOG\b/i.test(captured);

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
    }
  }
}

/** Parse the optional TAG / FORMAT / DELETE INPUT clauses from the trailing text. */
export function parseBackupOptions(text: string): {
  tag?: string; format?: string; deleteInput?: boolean;
} {
  const out: { tag?: string; format?: string; deleteInput?: boolean } = {};
  const tagMatch = text.match(/\bTAG\s+'([^']+)'/i);
  if (tagMatch) out.tag = tagMatch[1].toUpperCase();
  const fmtMatch = text.match(/\bFORMAT\s+'([^']+)'/i);
  if (fmtMatch) out.format = fmtMatch[1];
  if (/\bDELETE\s+INPUT\b/i.test(text)) out.deleteInput = true;
  return out;
}

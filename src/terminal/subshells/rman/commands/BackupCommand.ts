/**
 * BackupCommand — dispatches BACKUP DATABASE / ARCHIVELOG / TABLESPACE.
 *
 * Args come from the dispatcher's regex capture groups; for tablespace
 * the captured name is in args[0].
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { JobBuilder } from '../job/JobBuilder';

export class BackupCommand implements IRmanCommand<void> {
  readonly name = 'BACKUP';

  constructor(private readonly mode: 'database' | 'archivelog' | 'tablespace') {}

  execute(args: string[], { engine }: RmanCommandContext): Result<void, RmanError> {
    const job = this.mode === 'database'    ? JobBuilder.backupDatabase()
              : this.mode === 'archivelog'  ? JobBuilder.backupArchivelog()
              :                               JobBuilder.backupTablespace(args[0] ?? 'USERS');
    return engine.run(job);
  }
}

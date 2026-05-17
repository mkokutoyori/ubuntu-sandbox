import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand } from './types';

export class HelpCommand implements IRmanCommand<string[]> {
  readonly name = 'HELP';
  execute(): Result<string[], RmanError> {
    return ok([
      '',
      '    RMAN commands:',
      '',
      '    ALLOCATE           - Allocate a channel inside a RUN block',
      '    BACKUP             - Back up database, tablespace, datafile, archivelog',
      '    CATALOG            - Register an existing datafile copy or backup piece',
      '    CHANGE             - Toggle AVAILABLE/UNAVAILABLE or delete by tag',
      '    CONFIGURE          - Adjust persistent RMAN configuration',
      '    CONNECT            - Connect to target or catalog database',
      '    CROSSCHECK         - Verify backup or archived-log availability',
      '    DELETE             - Delete backups, copies, or archived logs',
      '    DUPLICATE          - Clone the database onto an auxiliary instance',
      '    EXIT               - Exit RMAN',
      '    HELP               - Display this help',
      '    LIST               - List backups, archived logs, copies',
      '    QUIT               - Exit RMAN',
      '    RECOVER            - Perform media recovery',
      '    RELEASE            - Release a channel inside a RUN block',
      '    REPORT             - Report schema, need-backup, obsolete, unrecoverable',
      '    RESTORE            - Restore database, tablespace, or datafile',
      '    RUN                - Start a multi-statement RUN block',
      '    SET                - Set runtime bindings (e.g. SET NEWNAME ...)',
      '    SHOW               - Show RMAN configuration / retention / channels',
      '',
    ]);
  }
}

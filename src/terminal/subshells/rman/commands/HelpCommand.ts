import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class HelpCommand implements IRmanCommand<string[]> {
  readonly name = 'HELP';
  execute(): Result<string[], RmanError> {
    return ok([
      '',
      '    RMAN commands:',
      '',
      '    BACKUP             - Back up database files',
      '    CONNECT            - Connect to target or catalog database',
      '    CROSSCHECK         - Verify backup availability',
      '    DELETE             - Delete backups or copies',
      '    EXIT               - Exit RMAN',
      '    HELP               - Display this help',
      '    LIST               - List backups and copies',
      '    QUIT               - Exit RMAN',
      '    RECOVER            - Perform media recovery',
      '    REPORT             - Report on backup status',
      '    RESTORE            - Restore database files',
      '    SHOW               - Show RMAN configuration',
      '',
    ]);
  }
}

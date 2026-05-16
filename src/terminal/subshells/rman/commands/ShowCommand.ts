/**
 * ShowCommand — SHOW ALL. Synchronous render of session configuration.
 */

import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';

export class ShowCommand implements IRmanCommand<string[]> {
  readonly name = 'SHOW';

  execute(_args: string[], { policy, ctx }: RmanCommandContext): Result<string[], RmanError> {
    return ok([
      '',
      `RMAN configuration parameters for database with db_unique_name ${ctx.dbName} are:`,
      `CONFIGURE RETENTION POLICY TO ${policy.describe()};`,
      'CONFIGURE BACKUP OPTIMIZATION OFF; # default',
      'CONFIGURE DEFAULT DEVICE TYPE TO DISK; # default',
      'CONFIGURE CONTROLFILE AUTOBACKUP ON;',
      'CONFIGURE CONTROLFILE AUTOBACKUP FORMAT FOR DEVICE TYPE DISK TO \'%F\'; # default',
      'CONFIGURE DEVICE TYPE DISK PARALLELISM 1 BACKUP TYPE TO BACKUPSET; # default',
      'CONFIGURE DATAFILE BACKUP COPIES FOR DEVICE TYPE DISK TO 1; # default',
      'CONFIGURE ARCHIVELOG BACKUP COPIES FOR DEVICE TYPE DISK TO 1; # default',
      'CONFIGURE MAXSETSIZE TO UNLIMITED; # default',
      'CONFIGURE ENCRYPTION FOR DATABASE OFF; # default',
      'CONFIGURE ENCRYPTION ALGORITHM \'AES128\'; # default',
      'CONFIGURE COMPRESSION ALGORITHM \'BASIC\' AS OF RELEASE \'DEFAULT\' OPTIMIZE FOR LOAD TRUE;',
      'CONFIGURE ARCHIVELOG DELETION POLICY TO NONE; # default',
      '',
    ]);
  }
}

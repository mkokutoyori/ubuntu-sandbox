/**
 * V$RECOVERY_AREA_USAGE — FRA usage broken down by file type.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { recoveryAreaUsage } from '../storage/RecoveryArea';

registerView({
  name: 'V$RECOVERY_AREA_USAGE',
  comment: 'FRA usage per file type',
  query({ instance, runtime }) {
    const usage = recoveryAreaUsage(
      instance.getParameter('db_recovery_file_dest') ?? '',
      instance.getParameter('db_recovery_file_dest_size'),
      runtime);
    const total = Math.max(1, usage.limitBytes);
    return queryResult(
      [
        col.str('FILE_TYPE', 20),
        col.num('PERCENT_SPACE_USED'),
        col.num('PERCENT_SPACE_RECLAIMABLE'),
        col.num('NUMBER_OF_FILES'),
      ],
      [
        ['CONTROL FILE', 0, 0, 0],
        ['REDO LOG', 0, 0, 0],
        ['ARCHIVED LOG', (usage.archivedLogBytes / total) * 100, 0, usage.archivedLogCount],
        ['BACKUP PIECE', (usage.backupPieceBytes / total) * 100, 0, usage.backupPieceCount],
        ['IMAGE COPY', 0, 0, 0],
        ['FLASHBACK LOG', 0, 0, usage.flashbackLogCount],
        ['FOREIGN ARCHIVED LOG', 0, 0, 0],
        ['AUXILIARY DATAFILE COPY', 0, 0, 0],
      ]
    );
  },
});

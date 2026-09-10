/**
 * V$RECOVERY_FILE_DEST — FRA destination size & usage.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { recoveryAreaUsage } from '../storage/RecoveryArea';

registerView({
  name: 'V$RECOVERY_FILE_DEST',
  comment: 'Fast recovery area configuration',
  query({ instance, runtime }) {
    const usage = recoveryAreaUsage(
      instance.getParameter('db_recovery_file_dest') ?? '',
      instance.getParameter('db_recovery_file_dest_size'),
      runtime);
    return queryResult(
      [
        col.str('NAME', 513),
        col.num('SPACE_LIMIT'),
        col.num('SPACE_USED'),
        col.num('SPACE_RECLAIMABLE'),
        col.num('NUMBER_OF_FILES'),
      ],
      [[usage.destination, usage.limitBytes, usage.usedBytes,
        Math.floor(usage.usedBytes * 0.1), usage.fileCount]]
    );
  },
});

/**
 * V$BACKUP_ARCHIVELOG_DETAILS — verbose archive-log backup detail.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_ARCHIVELOG_DETAILS',
  comment: 'Detailed archive-log backup information',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SESSION_RECID'),
        col.str('STATUS', 11),
        col.num('THREAD#'),
        col.num('SEQUENCE#'),
        col.num('SETSTAMP'),
        col.num('BLOCKS'),
        col.num('BLOCK_SIZE'),
        col.date('FIRST_TIME'),
        col.date('NEXT_TIME'),
        col.num('NUM_PIECES'),
      ],
      runtime.backups.filter(b => b.type === 'ARCHIVELOG').map((b, idx) => [
        idx + 1, b.status, 1, b.setId, b.setId,
        Math.ceil(b.bytes / 512), 512,
        new Date(b.startedAt).toISOString(),
        new Date(b.completedAt).toISOString(),
        1,
      ])
    );
  },
});

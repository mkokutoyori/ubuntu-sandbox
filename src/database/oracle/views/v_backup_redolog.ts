/**
 * V$BACKUP_REDOLOG — archived redo log members covered by backups.
 *
 * Fed by `oracle.backup.recorded { type: 'ARCHIVELOG' }`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_REDOLOG',
  comment: 'Archived redo logs covered by backups',
  query({ runtime }) {
    return queryResult(
      [
        col.num('RECID'),
        col.num('SET_STAMP'),
        col.num('THREAD#'),
        col.num('SEQUENCE#'),
        col.num('RESETLOGS_CHANGE#'),
        col.date('FIRST_TIME'),
        col.date('NEXT_TIME'),
        col.num('BLOCKS'),
        col.num('BLOCK_SIZE'),
      ],
      runtime.backups
        .filter(b => b.type === 'ARCHIVELOG')
        .map((b, idx) => [
          idx + 1, b.setId, 1, b.setId, 0,
          new Date(b.startedAt).toISOString(),
          new Date(b.completedAt).toISOString(),
          Math.ceil(b.bytes / 512), 512,
        ])
    );
  },
});

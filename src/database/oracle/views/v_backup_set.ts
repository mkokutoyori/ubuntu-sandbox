/**
 * V$BACKUP_SET — RMAN backup sets recorded against the instance.
 *
 * Snapshots `runtime.backups`, which is populated by `oracle.backup.recorded`.
 * One row per distinct set_id; multiple pieces per set are projected via
 * V$BACKUP_PIECE.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_SET',
  comment: 'RMAN backup sets',
  query({ runtime }) {
    const bySet = new Map<number, typeof runtime.backups[number]>();
    for (const b of runtime.backups) {
      if (!bySet.has(b.setId)) bySet.set(b.setId, b);
    }
    return queryResult(
      [
        col.num('SET_STAMP'),
        col.num('SET_COUNT'),
        col.num('BACKUP_TYPE'),
        col.str('CONTROLFILE_INCLUDED', 8),
        col.num('INCREMENTAL_LEVEL'),
        col.num('PIECES'),
        col.date('START_TIME'),
        col.date('COMPLETION_TIME'),
        col.num('BLOCK_SIZE'),
        col.str('STATUS', 1),
      ],
      [...bySet.values()].map(b => [
        b.setId, 1,
        b.type === 'INCREMENTAL' ? 2 : b.type === 'ARCHIVELOG' ? 4 : 1,
        b.type === 'CONTROLFILE' ? 'YES' : 'NO',
        b.type === 'INCREMENTAL' ? 1 : 0,
        runtime.backups.filter(x => x.setId === b.setId).length,
        new Date(b.startedAt).toISOString(),
        new Date(b.completedAt).toISOString(),
        8192,
        b.status === 'COMPLETED' ? 'A' : 'X',
      ])
    );
  },
});

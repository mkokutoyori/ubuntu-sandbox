/**
 * V$BACKUP_PIECE — individual backup pieces (one row per file produced).
 *
 * Snapshots every entry of `runtime.backups`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_PIECE',
  comment: 'RMAN backup pieces',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SET_STAMP'),
        col.num('SET_COUNT'),
        col.num('PIECE#'),
        col.str('HANDLE', 513),
        col.num('BYTES'),
        col.date('START_TIME'),
        col.date('COMPLETION_TIME'),
        col.str('STATUS', 1),
        col.str('DEVICE_TYPE', 17),
      ],
      runtime.backups.map(b => [
        b.setId, 1, b.pieceId, b.handle, b.bytes,
        new Date(b.startedAt).toISOString(),
        new Date(b.completedAt).toISOString(),
        b.status === 'COMPLETED' ? 'A' : 'X',
        'DISK',
      ])
    );
  },
});

/**
 * V$RMAN_STATUS — RMAN job progress.
 *
 * Snapshots `runtime.backups` aggregated by setId; each backup recorded
 * via `oracle.backup.recorded` surfaces as a single COMPLETED job row.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RMAN_STATUS',
  comment: 'RMAN job progress',
  query({ runtime }) {
    const bySet = new Map<number, typeof runtime.backups[number]>();
    for (const b of runtime.backups) {
      if (!bySet.has(b.setId)) bySet.set(b.setId, b);
    }
    return queryResult(
      [
        col.num('SESSION_KEY'),
        col.num('SESSION_RECID'),
        col.num('SESSION_STAMP'),
        col.str('OPERATION', 33),
        col.str('STATUS', 23),
        col.num('OBJECT_TYPE'),
        col.date('START_TIME'),
        col.date('END_TIME'),
        col.num('INPUT_BYTES'),
        col.num('OUTPUT_BYTES'),
      ],
      [...bySet.values()].map((b, idx) => [
        idx + 1, b.setId, b.startedAt,
        b.type === 'ARCHIVELOG' ? 'BACKUP ARCHIVELOG' : 'BACKUP',
        b.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
        b.type === 'ARCHIVELOG' ? 5 : 1,
        new Date(b.startedAt).toISOString(),
        new Date(b.completedAt).toISOString(),
        b.bytes, b.bytes,
      ])
    );
  },
});

/**
 * V$RMAN_BACKUP_JOB_DETAILS — detailed RMAN job statistics per session.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RMAN_BACKUP_JOB_DETAILS',
  comment: 'RMAN backup job summary',
  query({ runtime }) {
    const bySet = new Map<number, typeof runtime.backups[number]>();
    for (const b of runtime.backups) if (!bySet.has(b.setId)) bySet.set(b.setId, b);
    return queryResult(
      [
        col.num('SESSION_KEY'),
        col.num('SESSION_RECID'),
        col.str('INPUT_TYPE', 13),
        col.str('STATUS', 23),
        col.date('START_TIME'),
        col.date('END_TIME'),
        col.num('ELAPSED_SECONDS'),
        col.num('INPUT_BYTES'),
        col.num('OUTPUT_BYTES'),
        col.num('COMPRESSION_RATIO'),
      ],
      [...bySet.values()].map((b, idx) => [
        idx + 1, b.setId, b.type,
        b.status === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
        new Date(b.startedAt).toISOString(),
        new Date(b.completedAt).toISOString(),
        Math.max(1, Math.floor((b.completedAt - b.startedAt) / 1000)),
        b.bytes, b.bytes, 1,
      ])
    );
  },
});

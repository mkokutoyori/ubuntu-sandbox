/**
 * DBA_HIST_SNAPSHOT — AWR snapshots.
 *
 * Synthesises a snapshot every hour since the actor's startedAt; the
 * count reflects the elapsed simulator time. Each snapshot id is
 * monotonically increasing.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HIST_SNAPSHOT',
  comment: 'AWR snapshots',
  query({ runtime }) {
    const now = Date.now();
    const elapsedHours = Math.max(1, Math.floor((now - runtime.startedAt) / 3_600_000));
    const rows: (string | number)[][] = [];
    for (let i = 0; i < Math.min(elapsedHours, 200); i++) {
      const end = now - i * 3_600_000;
      const begin = end - 3_600_000;
      rows.push([
        elapsedHours - i, 1, 1, 1,
        new Date(begin).toISOString(),
        new Date(end).toISOString(),
        'COMPLETED', 'YES', 'TYPICAL',
      ]);
    }
    return queryResult(
      [
        col.num('SNAP_ID'),
        col.num('DBID'),
        col.num('INSTANCE_NUMBER'),
        col.num('SNAP_LEVEL'),
        col.date('BEGIN_INTERVAL_TIME'),
        col.date('END_INTERVAL_TIME'),
        col.str('STATUS', 9),
        col.str('STARTUP_TIME', 19),
        col.str('FLUSH_LEVEL', 8),
      ],
      rows
    );
  },
});

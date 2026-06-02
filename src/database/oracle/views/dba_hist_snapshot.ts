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
  query({ instance, runtime }) {
    const cols = [
      col.num('SNAP_ID'),
      col.num('DBID'),
      col.num('INSTANCE_NUMBER'),
      col.num('SNAP_LEVEL'),
      col.date('BEGIN_INTERVAL_TIME'),
      col.date('END_INTERVAL_TIME'),
      col.str('STATUS', 9),
      col.str('STARTUP_TIME', 19),
      col.str('FLUSH_LEVEL', 8),
      col.num('FLUSH_ELAPSED'),
      col.str('SOURCE', 8),
    ];
    const real = instance.awrManager.getSnapshots();
    if (real.length > 0) {
      return queryResult(cols, real.map(s => [
        s.snapId, s.dbid, s.instanceNumber,
        s.snapLevel === 'ALL' ? 2 : s.snapLevel === 'BASIC' ? 0 : 1,
        s.beginInterval.toISOString(), s.endInterval.toISOString(),
        s.status, s.startupTime.toISOString().slice(0, 19),
        s.snapLevel, s.flushElapsedSeconds,
        s.manual ? 'MANUAL' : 'AUTO',
      ]));
    }
    // Synthetic hourly snapshots so DBA_HIST_SNAPSHOT is never empty.
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
        'COMPLETED', 'YES', 'TYPICAL', 1, 'AUTO',
      ]);
    }
    return queryResult(cols, rows);
  },
});

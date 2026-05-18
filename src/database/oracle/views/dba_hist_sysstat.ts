/**
 * DBA_HIST_SYSSTAT — historical SYSSTAT values per snapshot.
 *
 * Generates a snapshot row per hourly bucket × statistic, using the
 * current runtime-derived value (a real AWR records deltas but for our
 * purposes the running cumulative counter is the meaningful surface).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { SYSSTAT_DEFINITIONS } from './v_statname';

registerView({
  name: 'DBA_HIST_SYSSTAT',
  comment: 'Historical SYSSTAT values',
  query({ runtime }) {
    const now = Date.now();
    const elapsedHours = Math.max(1, Math.floor((now - runtime.startedAt) / 3_600_000));
    const buckets = Math.min(elapsedHours, 100);
    const rows: (string | number)[][] = [];
    for (let b = 0; b < buckets; b++) {
      const snapId = elapsedHours - b;
      SYSSTAT_DEFINITIONS.forEach((def, idx) => {
        rows.push([snapId, 1234567890, 1, idx, def.name, def.value(runtime)]);
      });
    }
    return queryResult(
      [
        col.num('SNAP_ID'),
        col.num('DBID'),
        col.num('INSTANCE_NUMBER'),
        col.num('STAT_ID'),
        col.str('STAT_NAME', 64),
        col.num('VALUE'),
      ],
      rows
    );
  },
});

/**
 * DBA_HIST_SYSSTAT — historical SYSSTAT values per snapshot.
 *
 * Backed by AwrSnapshotManager when real snapshots exist. Falls back
 * to a synthetic per-hour view derived from current runtime counters
 * so DBA_HIST_SYSSTAT is never empty on a fresh database.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { SYSSTAT_DEFINITIONS } from './v_statname';

registerView({
  name: 'DBA_HIST_SYSSTAT',
  comment: 'Historical SYSSTAT values',
  query({ instance, runtime }) {
    const cols = [
      col.num('SNAP_ID'),
      col.num('DBID'),
      col.num('INSTANCE_NUMBER'),
      col.num('STAT_ID'),
      col.str('STAT_NAME', 64),
      col.num('VALUE'),
    ];
    const real = instance.awrManager.getSnapshots();
    if (real.length > 0) {
      const rows: (string | number)[][] = [];
      for (const s of real) {
        s.sysStats.forEach((st, idx) => {
          rows.push([s.snapId, s.dbid, s.instanceNumber, idx, st.statName, st.value]);
        });
      }
      return queryResult(cols, rows);
    }
    // Synthetic fallback.
    const now = Date.now();
    const elapsedHours = Math.max(1, Math.floor((now - runtime.startedAt) / 3_600_000));
    const buckets = Math.min(elapsedHours, 100);
    const rows: (string | number)[][] = [];
    for (let b = 0; b < buckets; b++) {
      const snapId = elapsedHours - b;
      SYSSTAT_DEFINITIONS.forEach((def, idx) => {
        rows.push([snapId, instance.getDbId(), 1, idx, def.name, def.value(runtime)]);
      });
    }
    return queryResult(cols, rows);
  },
});

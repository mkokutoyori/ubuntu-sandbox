/**
 * DBA_HIST_SYSMETRIC_HISTORY — historical metric samples.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { METRIC_CATALOGUE } from './v_sysmetric';

registerView({
  name: 'DBA_HIST_SYSMETRIC_HISTORY',
  comment: 'Historical metric samples',
  query(ctx) {
    const sample = queryView('V$SYSMETRIC', ctx);
    if (!sample) return queryResult([], []);
    const now = Date.now();
    const elapsedHours = Math.max(1, Math.floor((now - ctx.runtime.startedAt) / 3_600_000));
    const rows: (string | number)[][] = [];
    for (let b = 0; b < Math.min(elapsedHours, 100); b++) {
      const snapId = elapsedHours - b;
      const end = now - b * 3_600_000;
      const begin = end - 3_600_000;
      METRIC_CATALOGUE.forEach((m, i) => {
        const v = (sample.rows[i]?.[6] as number) ?? 0;
        rows.push([
          snapId, m.id, m.name,
          new Date(begin).toISOString(), new Date(end).toISOString(),
          6000, v, m.unit,
        ]);
      });
    }
    return queryResult(
      [
        col.num('SNAP_ID'),
        col.num('METRIC_ID'),
        col.str('METRIC_NAME', 64),
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE'),
        col.num('VALUE'),
        col.str('METRIC_UNIT', 64),
      ],
      rows
    );
  },
});

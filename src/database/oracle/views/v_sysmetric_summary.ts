/**
 * V$SYSMETRIC_SUMMARY — last-hour min/max/avg/stddev per metric.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { METRIC_CATALOGUE } from './v_sysmetric';

registerView({
  name: 'V$SYSMETRIC_SUMMARY',
  comment: 'Hourly metric summary',
  query(ctx) {
    const sample = queryView('V$SYSMETRIC', ctx);
    if (!sample) return queryResult([], []);
    const now = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('METRIC_ID'),
        col.str('METRIC_NAME', 64),
        col.num('MINVAL'),
        col.num('MAXVAL'),
        col.num('AVERAGE'),
        col.num('STANDARD_DEVIATION'),
        col.num('NUM_INTERVAL'),
      ],
      METRIC_CATALOGUE.map((m, i) => {
        const v = (sample.rows[i]?.[6] as number) ?? 0;
        return [
          new Date(now - 3600_000).toISOString(),
          new Date(now).toISOString(),
          m.id, m.name, v, v, v, 0, 60,
        ];
      })
    );
  },
});

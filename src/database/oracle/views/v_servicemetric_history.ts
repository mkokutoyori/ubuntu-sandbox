/**
 * V$SERVICEMETRIC_HISTORY — last-hour history of V$SERVICEMETRIC.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SERVICEMETRIC_HISTORY',
  comment: 'Per-service metric history',
  query(ctx) {
    const sample = queryView('V$SERVICEMETRIC', ctx);
    if (!sample) return queryResult([], []);
    const rows: (string | number)[][] = [];
    const now = Date.now();
    for (let b = 0; b < 60; b++) {
      const end = now - b * 60_000;
      const begin = end - 60_000;
      sample.rows.forEach(r => {
        rows.push([new Date(begin).toISOString(), new Date(end).toISOString(),
          6000, r[3], r[4], r[5], r[6], r[7], r[8], r[9]]);
      });
    }
    return queryResult(sample.columns, rows);
  },
});

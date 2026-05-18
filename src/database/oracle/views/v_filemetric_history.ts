/**
 * V$FILEMETRIC_HISTORY — last-hour history of V$FILEMETRIC.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FILEMETRIC_HISTORY',
  comment: 'Per-datafile metric history',
  query(ctx) {
    const sample = queryView('V$FILEMETRIC', ctx);
    if (!sample) return queryResult([], []);
    const rows: (string | number)[][] = [];
    const now = Date.now();
    for (let b = 0; b < 60; b++) {
      const end = now - b * 60_000;
      const begin = end - 60_000;
      sample.rows.forEach(r => {
        rows.push([new Date(begin).toISOString(), new Date(end).toISOString(),
          6000, r[3], r[4], r[5], r[6], r[7]]);
      });
    }
    return queryResult(sample.columns, rows);
  },
});

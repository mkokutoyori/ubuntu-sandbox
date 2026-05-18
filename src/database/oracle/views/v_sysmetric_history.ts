/**
 * V$SYSMETRIC_HISTORY — rolling 1-hour per-minute metric history.
 *
 * We synthesise N buckets covering the elapsed simulator time, each
 * holding the same instant snapshot of the current counters (we don't
 * record per-minute deltas separately). This keeps the view non-empty
 * and refreshes whenever the underlying event-fed counters change.
 */

import { queryView } from './registry';
import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { METRIC_CATALOGUE } from './v_sysmetric';

registerView({
  name: 'V$SYSMETRIC_HISTORY',
  comment: 'Per-minute rolling metric history',
  query(ctx) {
    const sample = queryView('V$SYSMETRIC', ctx);
    if (!sample) return queryResult([], []);
    const rows: (string | number)[][] = [];
    const now = Date.now();
    const buckets = Math.min(60, Math.max(1, Math.floor((now - ctx.runtime.startedAt) / 60_000)));
    for (let b = 0; b < buckets; b++) {
      const end = now - b * 60_000;
      const begin = end - 60_000;
      for (let i = 0; i < METRIC_CATALOGUE.length; i++) {
        const sampleRow = sample.rows[i] ?? [];
        const value = (sampleRow[6] as number) ?? 0;
        rows.push([
          new Date(begin).toISOString(), new Date(end).toISOString(),
          6000, '2', METRIC_CATALOGUE[i].id, METRIC_CATALOGUE[i].name,
          value, METRIC_CATALOGUE[i].unit,
        ]);
      }
    }
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.str('GROUP_ID', 16),
        col.num('METRIC_ID'),
        col.str('METRIC_NAME', 64),
        col.num('VALUE'),
        col.str('METRIC_UNIT', 64),
      ],
      rows
    );
  },
});

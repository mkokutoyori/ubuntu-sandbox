/**
 * V$SESSION_METRIC — latest metric values per session over a short interval.
 *
 * Snapshots the latest entry per (sid, metric) from `runtime.sessionMetrics`,
 * which is populated by `oracle.session.metric` events.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_METRIC',
  comment: 'Latest per-session metric values',
  query({ runtime }) {
    const latest = new Map<string, typeof runtime.sessionMetrics[number]>();
    for (const m of runtime.sessionMetrics) latest.set(`${m.sid}:${m.metric}`, m);
    return queryResult(
      [
        col.num('SID'),
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE'),
        col.str('METRIC_NAME', 64),
        col.num('METRIC_ID'),
        col.num('VALUE'),
        col.str('METRIC_UNIT', 64),
      ],
      [...latest.values()].map(m => [
        m.sid,
        new Date(m.ts - 60_000).toISOString(),
        new Date(m.ts).toISOString(),
        60_000, m.metric, hash(m.metric), m.value, 'count',
      ])
    );
  },
});

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

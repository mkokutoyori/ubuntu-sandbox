/**
 * V$SESSION_METRIC_HISTORY — rolling history per session metric.
 *
 * Snapshots the full `runtime.sessionMetrics` ring buffer (capped by the
 * actor's drain budget). Each row is one published `oracle.session.metric`
 * event.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_METRIC_HISTORY',
  comment: 'Per-session metric history (rolling window)',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SID'),
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.str('METRIC_NAME', 64),
        col.num('VALUE'),
      ],
      runtime.sessionMetrics.map(m => [
        m.sid,
        new Date(m.ts - 60_000).toISOString(),
        new Date(m.ts).toISOString(),
        m.metric, m.value,
      ])
    );
  },
});

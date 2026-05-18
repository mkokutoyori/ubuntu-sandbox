/**
 * V$EVENTMETRIC — current per-event wait metric snapshot.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$EVENTMETRIC',
  comment: 'Per-event wait metric snapshot',
  query({ runtime }) {
    const agg = new Map<string, { event: string; cls: string; waits: number; totMicros: number }>();
    for (const w of runtime.waitHistory) {
      const cur = agg.get(w.event);
      if (cur) { cur.waits++; cur.totMicros += w.waitTimeMicros; }
      else agg.set(w.event, { event: w.event, cls: w.waitClass, waits: 1, totMicros: w.waitTimeMicros });
    }
    const end = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.num('EVENT_ID'),
        col.str('EVENT_NAME', 64),
        col.num('NUM_SESS_WAITING'),
        col.num('TIME_WAITED'),
        col.num('WAIT_COUNT'),
      ],
      [...agg.values()].map((a, idx) => [
        new Date(end - 60_000).toISOString(),
        new Date(end).toISOString(),
        6000, idx + 1, a.event,
        runtime.sessions.size, Math.floor(a.totMicros / 10_000), a.waits,
      ])
    );
  },
});

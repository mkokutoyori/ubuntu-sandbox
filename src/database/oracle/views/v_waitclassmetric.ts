/**
 * V$WAITCLASSMETRIC — current per-wait-class metric snapshot.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { EVENT_CATALOGUE } from './v_event_name';

registerView({
  name: 'V$WAITCLASSMETRIC',
  comment: 'Per-wait-class metric snapshot',
  query({ runtime }) {
    const classes = [...new Set(EVENT_CATALOGUE.map(e => e.waitClass))];
    const totals = new Map<string, { waits: number; tot: number }>();
    for (const c of classes) totals.set(c, { waits: 0, tot: 0 });
    for (const w of runtime.waitHistory) {
      const t = totals.get(w.waitClass);
      if (t) { t.waits++; t.tot += w.waitTimeMicros; }
    }
    const end = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.num('WAIT_CLASS_ID'),
        col.str('WAIT_CLASS', 64),
        col.num('AVERAGE_WAITER_COUNT'),
        col.num('DBTIME_IN_WAIT'),
        col.num('TIME_WAITED'),
        col.num('WAIT_COUNT'),
      ],
      classes.map((c, idx) => {
        const t = totals.get(c)!;
        return [
          new Date(end - 60_000).toISOString(), new Date(end).toISOString(),
          6000, idx, c, runtime.sessions.size,
          Math.min(100, Math.floor(t.tot / 10_000)),
          Math.floor(t.tot / 10_000), t.waits,
        ];
      })
    );
  },
});

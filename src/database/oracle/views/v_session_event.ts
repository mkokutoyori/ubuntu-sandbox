/**
 * V$SESSION_EVENT — per-session cumulative wait stats.
 *
 * Snapshots OracleRuntimeState.waitHistory and groups by SID + event.
 * Updated whenever the actor appends a new wait record.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_EVENT',
  comment: 'Cumulative wait statistics per session and event',
  query({ runtime }) {
    const agg = new Map<string, { sid: number; event: string; cls: string; waits: number; totMicros: number }>();
    for (const w of runtime.waitHistory) {
      const key = `${w.sid}:${w.event}`;
      const cur = agg.get(key);
      if (cur) { cur.waits++; cur.totMicros += w.waitTimeMicros; }
      else agg.set(key, { sid: w.sid, event: w.event, cls: w.waitClass, waits: 1, totMicros: w.waitTimeMicros });
    }
    return queryResult(
      [
        col.num('SID'),
        col.str('EVENT', 64),
        col.num('TOTAL_WAITS'),
        col.num('TOTAL_TIMEOUTS'),
        col.num('TIME_WAITED'),
        col.num('AVERAGE_WAIT'),
        col.num('MAX_WAIT'),
        col.num('TIME_WAITED_MICRO'),
        col.str('WAIT_CLASS', 64),
      ],
      [...agg.values()].map(a => [
        a.sid, a.event, a.waits, 0,
        Math.floor(a.totMicros / 10_000),
        a.waits > 0 ? Math.floor(a.totMicros / a.waits / 10_000) : 0,
        0, a.totMicros, a.cls,
      ])
    );
  },
});

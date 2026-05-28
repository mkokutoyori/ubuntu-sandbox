/**
 * V$SESSION_EVENT — per-session cumulative wait stats.
 *
 * Now backed by the WaitEventEngine, which observes the same bus
 * and synthesises realistic wait rows from SQL parse / execute /
 * commit traffic. Existing runtime-state rows are still appended
 * (legacy actor path) so this view remains the union of both sources.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_EVENT',
  comment: 'Cumulative wait statistics per session and event',
  query({ runtime, instance }) {
    const agg = new Map<string, { sid: number; event: string; cls: string;
                                  waits: number; totMicros: number; maxMicros: number }>();
    // Legacy waitHistory path (kept for compatibility).
    for (const w of runtime.waitHistory) {
      const key = `${w.sid}:${w.event}`;
      const cur = agg.get(key);
      if (cur) {
        cur.waits++; cur.totMicros += w.waitTimeMicros;
        if (w.waitTimeMicros > cur.maxMicros) cur.maxMicros = w.waitTimeMicros;
      } else {
        agg.set(key, { sid: w.sid, event: w.event, cls: w.waitClass,
                       waits: 1, totMicros: w.waitTimeMicros, maxMicros: w.waitTimeMicros });
      }
    }
    // WaitEventEngine rows.
    for (const r of instance.getWaitEngine()?.getSessionEvents() ?? []) {
      const key = `${r.sid}:${r.event}`;
      const cur = agg.get(key);
      if (cur) {
        cur.waits += r.totalWaits; cur.totMicros += r.timeWaitedMicros;
        if (r.maxWaitMicros > cur.maxMicros) cur.maxMicros = r.maxWaitMicros;
      } else {
        agg.set(key, { sid: r.sid, event: r.event, cls: r.waitClass,
                       waits: r.totalWaits, totMicros: r.timeWaitedMicros,
                       maxMicros: r.maxWaitMicros });
      }
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
        Math.floor(a.maxMicros / 10_000),
        a.totMicros, a.cls,
      ]),
    );
  },
});

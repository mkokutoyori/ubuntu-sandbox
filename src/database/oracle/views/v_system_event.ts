/**
 * V$SYSTEM_EVENT — cumulative wait stats per event across the instance.
 *
 * Aggregated from the wait history maintained by
 * OracleRuntimeStateActor in response to wait events recorded via the
 * actor's recordWait() entry point. View itself only snapshots.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { EVENT_CATALOGUE } from './v_event_name';

registerView({
  name: 'V$SYSTEM_EVENT',
  comment: 'Cumulative system-wide wait statistics per event',
  query({ runtime, instance }) {
    const agg = new Map<string, { event: string; cls: string; waits: number; totMicros: number }>();
    for (const w of runtime.waitHistory) {
      const key = w.event;
      const cur = agg.get(key);
      if (cur) { cur.waits++; cur.totMicros += w.waitTimeMicros; }
      else agg.set(key, { event: w.event, cls: w.waitClass, waits: 1, totMicros: w.waitTimeMicros });
    }
    for (const r of instance.getWaitEngine()?.getSystemEvents() ?? []) {
      const cur = agg.get(r.event);
      if (cur) { cur.waits += r.totalWaits; cur.totMicros += r.timeWaitedMicros; }
      else agg.set(r.event, { event: r.event, cls: r.waitClass, waits: r.totalWaits, totMicros: r.timeWaitedMicros });
    }
    // Always seed idle events with a zero-row so V$SYSTEM_EVENT is never
    // empty — matches real Oracle behaviour where each catalogued event
    // appears even if it never fired.
    for (const e of EVENT_CATALOGUE) {
      if (!agg.has(e.name)) {
        agg.set(e.name, { event: e.name, cls: e.waitClass, waits: 0, totMicros: 0 });
      }
    }
    const rows = [...agg.values()].map(a => [
      a.event,
      a.waits,
      0,
      Math.floor(a.totMicros / 10_000), // centiseconds
      a.waits > 0 ? Math.floor(a.totMicros / a.waits / 10_000) : 0,
      a.totMicros,
      a.waits > 0 ? Math.floor(a.totMicros / a.waits) : 0,
      a.cls,
    ]);
    return queryResult(
      [
        col.str('EVENT', 64),
        col.num('TOTAL_WAITS'),
        col.num('TOTAL_TIMEOUTS'),
        col.num('TIME_WAITED'),
        col.num('AVERAGE_WAIT'),
        col.num('TIME_WAITED_MICRO'),
        col.num('AVERAGE_WAIT_MICRO'),
        col.str('WAIT_CLASS', 64),
      ],
      rows
    );
  },
});

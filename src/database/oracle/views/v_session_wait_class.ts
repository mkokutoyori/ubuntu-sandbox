/**
 * V$SESSION_WAIT_CLASS — per-session wait stats rolled up by class.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { EVENT_CATALOGUE } from './v_event_name';

registerView({
  name: 'V$SESSION_WAIT_CLASS',
  comment: 'Per-session waits rolled up by wait class',
  query({ runtime }) {
    const agg = new Map<string, { sid: number; cls: string; waits: number; tot: number }>();
    for (const w of runtime.waitHistory) {
      const key = `${w.sid}:${w.waitClass}`;
      const cur = agg.get(key);
      if (cur) { cur.waits++; cur.tot += w.waitTimeMicros; }
      else agg.set(key, { sid: w.sid, cls: w.waitClass, waits: 1, tot: w.waitTimeMicros });
    }
    // Seed every session × every class with a zero row for completeness.
    const classes = [...new Set(EVENT_CATALOGUE.map(e => e.waitClass))];
    for (const s of runtime.sessions.values()) {
      for (const c of classes) {
        const key = `${s.sid}:${c}`;
        if (!agg.has(key)) agg.set(key, { sid: s.sid, cls: c, waits: 0, tot: 0 });
      }
    }
    return queryResult(
      [
        col.num('SID'),
        col.num('SERIAL#'),
        col.num('WAIT_CLASS#'),
        col.num('WAIT_CLASS_ID'),
        col.str('WAIT_CLASS', 64),
        col.num('TOTAL_WAITS'),
        col.num('TIME_WAITED'),
      ],
      [...agg.values()].map(a => [
        a.sid, 1, classes.indexOf(a.cls), classes.indexOf(a.cls),
        a.cls, a.waits, Math.floor(a.tot / 10_000),
      ])
    );
  },
});

/**
 * V$SYSTEM_WAIT_CLASS — system-wide wait stats rolled up by class.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { EVENT_CATALOGUE } from './v_event_name';

registerView({
  name: 'V$SYSTEM_WAIT_CLASS',
  comment: 'System-wide waits rolled up by wait class',
  query({ runtime }) {
    const classes = [...new Set(EVENT_CATALOGUE.map(e => e.waitClass))];
    const totals = new Map<string, { waits: number; micros: number }>();
    for (const c of classes) totals.set(c, { waits: 0, micros: 0 });
    for (const w of runtime.waitHistory) {
      const t = totals.get(w.waitClass);
      if (t) { t.waits++; t.micros += w.waitTimeMicros; }
    }
    return queryResult(
      [
        col.num('WAIT_CLASS#'),
        col.num('WAIT_CLASS_ID'),
        col.str('WAIT_CLASS', 64),
        col.num('TOTAL_WAITS'),
        col.num('TIME_WAITED'),
      ],
      classes.map((c, idx) => {
        const t = totals.get(c)!;
        return [idx, idx, c, t.waits, Math.floor(t.micros / 10_000)];
      })
    );
  },
});

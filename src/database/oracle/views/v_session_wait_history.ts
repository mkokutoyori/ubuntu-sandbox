/**
 * V$SESSION_WAIT_HISTORY — last 10 wait events per session.
 *
 * Backed by OracleRuntimeState.waitHistory, which the runtime actor
 * appends to whenever a wait is recorded.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_WAIT_HISTORY',
  comment: 'Last 10 waits per session',
  query({ runtime }) {
    const perSid = new Map<number, typeof runtime.waitHistory>();
    for (const w of runtime.waitHistory) {
      const arr = perSid.get(w.sid) ?? [];
      arr.push(w);
      perSid.set(w.sid, arr);
    }
    const rows: (string | number)[][] = [];
    for (const [sid, list] of perSid) {
      const lastTen = list.slice(-10).reverse();
      lastTen.forEach((w, idx) => {
        rows.push([sid, idx + 1, w.seq, w.event, w.waitTimeMicros, w.waitTimeMicros, w.waitClass]);
      });
    }
    return queryResult(
      [
        col.num('SID'),
        col.num('SEQ#'),
        col.num('EVENT#'),
        col.str('EVENT', 64),
        col.num('WAIT_TIME_MICRO'),
        col.num('TIME_WAITED_MICRO'),
        col.str('WAIT_CLASS', 64),
      ],
      rows
    );
  },
});

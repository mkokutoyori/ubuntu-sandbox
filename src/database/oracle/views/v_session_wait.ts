/**
 * V$SESSION_WAIT — current wait events per session.
 *
 * Snapshots the most recent wait record per session from the runtime
 * wait history. Sessions that haven't waited (or whose last wait was
 * idle) get an idle 'SQL*Net message from client' filler row, matching
 * real Oracle.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_WAIT',
  comment: 'Current wait event per active session',
  query({ runtime }) {
    const latest = new Map<number, { sid: number; event: string; cls: string; seq: number; waitMicros: number }>();
    for (const w of runtime.waitHistory) {
      latest.set(w.sid, { sid: w.sid, event: w.event, cls: w.waitClass, seq: w.seq, waitMicros: w.waitTimeMicros });
    }
    const rows: (string | number)[][] = [];
    for (const s of runtime.sessions.values()) {
      const w = latest.get(s.sid);
      if (w) {
        rows.push([s.sid, w.seq, w.event, w.waitMicros, w.waitMicros, 'WAITED SHORT TIME', w.cls]);
      } else {
        rows.push([s.sid, 0, 'SQL*Net message from client', 0, 0, 'WAITING', 'Idle']);
      }
    }
    return queryResult(
      [
        col.num('SID'),
        col.num('SEQ#'),
        col.str('EVENT', 64),
        col.num('WAIT_TIME_MICRO'),
        col.num('TIME_WAITED_MICRO'),
        col.str('STATE', 19),
        col.str('WAIT_CLASS', 64),
      ],
      rows
    );
  },
});

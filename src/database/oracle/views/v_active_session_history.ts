/**
 * V$ACTIVE_SESSION_HISTORY — ASH circular buffer.
 *
 * In a real Oracle MMON samples active sessions every second; we
 * synthesise samples directly from the wait-history actor. Each sample
 * row links back to the session, the SQL it was running, and the wait
 * event observed.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ACTIVE_SESSION_HISTORY',
  comment: 'Active Session History (last 1h, in-memory)',
  query({ runtime }) {
    return queryResult(
      [
        col.date('SAMPLE_TIME'),
        col.num('SAMPLE_ID'),
        col.num('SESSION_ID'),
        col.num('SESSION_SERIAL#'),
        col.str('USER_ID', 30),
        col.str('SQL_ID', 13),
        col.str('EVENT', 64),
        col.str('WAIT_CLASS', 64),
        col.num('TIME_WAITED'),
        col.str('SESSION_STATE', 7),
      ],
      runtime.waitHistory.map((w, idx) => {
        const sess = [...runtime.sessions.values()].find(s => s.sid === w.sid);
        return [
          new Date(w.timestamp).toISOString(),
          idx + 1,
          w.sid,
          sess?.serial ?? 1,
          sess?.schema ?? 'SYS',
          sess?.lastSqlId ?? null,
          w.event,
          w.waitClass,
          w.waitTimeMicros,
          w.waitClass === 'Idle' ? 'WAITING' : 'ON CPU',
        ];
      })
    );
  },
});

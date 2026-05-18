/**
 * DBA_HIST_ACTIVE_SESS_HISTORY — historical ASH samples.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HIST_ACTIVE_SESS_HISTORY',
  comment: 'Historical Active Session History',
  query({ runtime }) {
    const now = Date.now();
    const elapsedHours = Math.max(1, Math.floor((now - runtime.startedAt) / 3_600_000));
    return queryResult(
      [
        col.num('SNAP_ID'),
        col.date('SAMPLE_TIME'),
        col.num('SESSION_ID'),
        col.str('USER_ID', 30),
        col.str('SQL_ID', 13),
        col.str('EVENT', 64),
        col.str('WAIT_CLASS', 64),
        col.num('TIME_WAITED'),
      ],
      runtime.waitHistory.map(w => {
        const snap = elapsedHours - Math.floor((now - w.timestamp) / 3_600_000);
        const sess = [...runtime.sessions.values()].find(s => s.sid === w.sid);
        return [
          snap, new Date(w.timestamp).toISOString(), w.sid,
          sess?.schema ?? 'SYS', sess?.lastSqlId ?? null as unknown as string,
          w.event, w.waitClass, w.waitTimeMicros,
        ];
      })
    );
  },
});

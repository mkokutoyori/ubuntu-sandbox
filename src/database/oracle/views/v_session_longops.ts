/**
 * V$SESSION_LONGOPS — long-running operation progress per session.
 *
 * Snapshots `runtime.longops`, which is populated by
 * `oracle.session.longops` events (typically published by RMAN, data
 * pump, or `DBMS_APPLICATION_INFO.SET_SESSION_LONGOPS`).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_LONGOPS',
  comment: 'Long-running operations',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SID'),
        col.num('SERIAL#'),
        col.str('OPNAME', 64),
        col.str('TARGET', 64),
        col.num('SOFAR'),
        col.num('TOTALWORK'),
        col.str('UNITS', 32),
        col.num('TIME_REMAINING'),
        col.num('ELAPSED_SECONDS'),
        col.str('MESSAGE', 512),
      ],
      runtime.longops.map(l => {
        const sess = runtime.sessions.get(l.sessionId);
        const ratio = l.totalwork ? l.sofar / l.totalwork : 1;
        const elapsedS = Math.floor((Date.now() - l.ts) / 1000);
        const remaining = ratio > 0 ? Math.floor(elapsedS * (1 - ratio) / ratio) : 0;
        return [
          l.sid, sess?.serial ?? 1, l.opname, l.target,
          l.sofar, l.totalwork, l.units, remaining, elapsedS,
          `${l.opname}: ${l.sofar}/${l.totalwork} ${l.units}`,
        ];
      })
    );
  },
});

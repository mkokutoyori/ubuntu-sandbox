/**
 * V$TEMPSEG_USAGE — temp segments currently in use per session.
 *
 * Derived from active sessions × event-fed work-area usage.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$TEMPSEG_USAGE',
  comment: 'Temp segment usage per session',
  query({ runtime }) {
    const active = [...runtime.sessions.values()].filter(s => s.status === 'ACTIVE');
    return queryResult(
      [
        col.str('USERNAME', 30),
        col.str('USER', 30),
        col.num('SESSION_ADDR'),
        col.num('SESSION_NUM'),
        col.str('SQLADDR', 16),
        col.num('SQLHASH'),
        col.str('SQL_ID', 13),
        col.str('TABLESPACE', 30),
        col.str('CONTENTS', 9),
        col.str('SEGTYPE', 9),
        col.num('EXTENTS'),
        col.num('BLOCKS'),
      ],
      active.map(s => [
        s.username, s.username, 0, s.sid, '00', 0,
        s.lastSqlId ?? null as unknown as string,
        'TEMP', 'TEMPORARY', 'SORT', 1, 128,
      ])
    );
  },
});

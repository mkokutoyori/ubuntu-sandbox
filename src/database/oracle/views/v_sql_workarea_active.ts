/**
 * V$SQL_WORKAREA_ACTIVE — currently-active work areas.
 *
 * Returns one row per currently-active session × SQL combination.
 * Empty when no session is active.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_WORKAREA_ACTIVE',
  comment: 'Currently-active work areas',
  query({ runtime }) {
    const active = [...runtime.sessions.values()].filter(s => s.status === 'ACTIVE' && s.lastSqlId);
    return queryResult(
      [
        col.num('WORKAREA_ADDRESS'),
        col.num('SID'),
        col.str('SQL_ID', 13),
        col.str('OPERATION_TYPE', 16),
        col.num('ACTUAL_MEM_USED'),
        col.num('MAX_MEM_USED'),
        col.num('TEMPSEG_SIZE'),
        col.str('POLICY', 12),
      ],
      active.map((s, idx) => [
        idx + 1, s.sid, s.lastSqlId!, 'SORT', 65536, 65536, 0, 'AUTO',
      ])
    );
  },
});

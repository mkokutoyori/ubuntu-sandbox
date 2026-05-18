/**
 * V$WAIT_CHAINS — blocker→waiter chains derived from runtime.locks.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$WAIT_CHAINS',
  comment: 'Blocker-waiter wait chains',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    let id = 1;
    for (const l of runtime.locks.filter(x => x.block)) {
      const blockers = runtime.locks.filter(b =>
        b !== l && b.type === l.type && b.id1 === l.id1 && b.id2 === l.id2 && b.lmode > 0
      );
      const blocker = blockers[0];
      rows.push([
        id++, blocker?.sid ?? 0, blocker?.sessionId ?? '', l.sid, l.sessionId,
        1, 'enqueue', l.type, 1, 0,
      ]);
    }
    return queryResult(
      [
        col.num('CHAIN_ID'),
        col.num('BLOCKER_SID'),
        col.str('BLOCKER_SESS_SERIAL#', 16),
        col.num('WAITING_SID'),
        col.str('WAITING_SESS_SERIAL#', 16),
        col.num('NUM_WAITERS'),
        col.str('IN_WAIT', 64),
        col.str('P1', 16),
        col.num('P1_TEXT'),
        col.num('IS_DEADLOCK'),
      ],
      rows
    );
  },
});

/**
 * V$ENQUEUE_LOCK — non-DML enqueue locks.
 *
 * Filtered projection of `runtime.locks` (event-fed via oracle.lock.event)
 * for non-DML enqueue types: ST, TM, US, etc.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ENQUEUE_LOCK',
  comment: 'Non-DML enqueue locks',
  query({ runtime }) {
    return queryResult(
      [
        col.str('ADDR', 16),
        col.num('KADDR'),
        col.num('SID'),
        col.str('TYPE', 2),
        col.num('ID1'),
        col.num('ID2'),
        col.num('LMODE'),
        col.num('REQUEST'),
        col.num('CTIME'),
      ],
      runtime.locks.filter(l => l.type !== 'TX').map(l => [
        '00' + l.sid.toString(16), 0, l.sid, l.type,
        l.id1, l.id2, l.lmode, l.request, 0,
      ])
    );
  },
});

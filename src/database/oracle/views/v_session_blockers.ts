/**
 * V$SESSION_BLOCKERS — current blocker/waiter graph.
 *
 * Derived from runtime.locks (event-fed). One row per blocked session.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_BLOCKERS',
  comment: 'Current blocker sessions per waiter',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    for (const l of runtime.locks.filter(x => x.block)) {
      const blocker = runtime.locks.find(b =>
        b !== l && b.type === l.type && b.id1 === l.id1 && b.id2 === l.id2 && b.lmode > 0
      );
      rows.push([l.sid, blocker?.sid ?? null as unknown as number, l.type, l.id1, l.id2]);
    }
    return queryResult(
      [
        col.num('SID'),
        col.num('BLOCKER_SID'),
        col.str('TYPE', 2),
        col.num('ID1'),
        col.num('ID2'),
      ],
      rows
    );
  },
});

/**
 * V$TRANSACTION_ENQUEUE — TX enqueues held by active transactions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$TRANSACTION_ENQUEUE',
  comment: 'TX enqueues held by active transactions',
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
        col.num('BLOCK'),
      ],
      [...runtime.transactions.values()].map((tx, idx) => [
        '00' + idx.toString(16), 0, 0, 'TX', tx.txId, 0, 6, 0, 0, 0,
      ])
    );
  },
});

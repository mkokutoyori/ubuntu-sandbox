/**
 * DBA_2PC_NEIGHBORS — neighbours of pending distributed transactions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_2PC_NEIGHBORS',
  comment: 'Pending 2PC neighbours',
  query() {
    return queryResult(
      [
        col.str('LOCAL_TRAN_ID', 22),
        col.str('IN_OUT', 3),
        col.str('DATABASE', 128),
        col.str('DBUSER_OWNER', 30),
        col.str('INTERFACE', 1),
        col.str('DBID', 16),
      ],
      []
    );
  },
});

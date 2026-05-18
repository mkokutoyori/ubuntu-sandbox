/**
 * DBA_2PC_PENDING — distributed transactions awaiting resolution.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_2PC_PENDING',
  comment: 'Pending two-phase commit transactions',
  query() {
    return queryResult(
      [
        col.str('LOCAL_TRAN_ID', 22),
        col.str('GLOBAL_TRAN_ID', 169),
        col.str('STATE', 16),
        col.str('MIXED', 3),
        col.str('ADVICE', 1),
        col.num('TRAN_COMMENT'),
        col.date('FAIL_TIME'),
        col.date('FORCE_TIME'),
        col.str('RETRY_TIME', 19),
        col.str('OS_USER', 30),
      ],
      []
    );
  },
});

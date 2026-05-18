/**
 * V$GLOBAL_TRANSACTION — distributed transactions in 2PC.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$GLOBAL_TRANSACTION',
  comment: 'Distributed two-phase commit transactions',
  query() {
    return queryResult(
      [
        col.str('FORMATID', 16),
        col.str('GLOBALID', 64),
        col.str('BRANCHID', 64),
        col.num('BRANCHES'),
        col.num('REFCOUNT'),
        col.str('PREPARECOUNT', 16),
        col.str('STATE', 8),
        col.num('FLAGS'),
        col.str('COUPLING', 16),
      ],
      []
    );
  },
});

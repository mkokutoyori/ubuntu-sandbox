/**
 * V$FLASHBACK_TXN_GRAPH — dependency graph between flashback transactions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FLASHBACK_TXN_GRAPH',
  comment: 'Flashback transaction dependency graph',
  query() {
    return queryResult(
      [
        col.str('XID', 16),
        col.str('DEPENDENT_XID', 16),
        col.num('DEPENDENCY_TYPE'),
      ],
      []
    );
  },
});

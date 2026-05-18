/**
 * V$FLASHBACK_TXN_MODS — modifications of compensated transactions.
 * Empty unless a flashback transaction query has populated it.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$FLASHBACK_TXN_MODS',
  comment: 'Flashback transaction modifications',
  query() {
    return queryResult(
      [
        col.str('XID', 16),
        col.num('OPERATION'),
        col.str('TABLE_NAME', 30),
        col.str('OWNER', 30),
        col.num('ROW_COUNT'),
      ],
      []
    );
  },
});

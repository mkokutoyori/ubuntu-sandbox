/**
 * V$ENQUEUE_STATISTICS — newer name of V$ENQUEUE_STAT. Same rows.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { enqueueStatRows } from './v_enqueue_stat';

registerView({
  name: 'V$ENQUEUE_STATISTICS',
  comment: 'Enqueue statistics (newer alias)',
  query({ runtime }) {
    return queryResult(
      [
        col.str('EQ_TYPE', 2),
        col.str('REQ_REASON', 64),
        col.num('TOTAL_REQ#'),
        col.num('SUCC_REQ#'),
        col.num('FAILED_REQ#'),
        col.num('CUM_WAIT_TIME'),
        col.num('EVENT#'),
      ],
      enqueueStatRows(runtime)
    );
  },
});

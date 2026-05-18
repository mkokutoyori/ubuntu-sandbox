/**
 * V$SGA_RESIZE_OPS — completed SGA resize operations.
 *
 * Snapshots the parameter-changed history for any *_size parameters
 * that have been modified. Currently empty unless ALTER SYSTEM has
 * fired matching events — the actor could be extended to capture the
 * history, but this view honours that contract today.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SGA_RESIZE_OPS',
  comment: 'Completed SGA resize operations',
  query() {
    return queryResult(
      [
        col.str('COMPONENT', 64),
        col.str('OPER_TYPE', 16),
        col.str('OPER_MODE', 12),
        col.str('PARAMETER', 64),
        col.num('INITIAL_SIZE'),
        col.num('TARGET_SIZE'),
        col.num('FINAL_SIZE'),
        col.str('STATUS', 12),
        col.date('START_TIME'),
        col.date('END_TIME'),
      ],
      []
    );
  },
});

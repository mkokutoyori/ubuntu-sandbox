/**
 * V$MEMORY_RESIZE_OPS — completed automatic memory resize operations.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$MEMORY_RESIZE_OPS',
  comment: 'Automatic memory resize history',
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

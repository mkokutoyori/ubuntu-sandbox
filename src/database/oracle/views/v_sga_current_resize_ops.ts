/**
 * V$SGA_CURRENT_RESIZE_OPS — in-flight SGA resize operations.
 *
 * Empty in our simulator — resizes complete synchronously via
 * `oracle.instance.parameter-changed`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SGA_CURRENT_RESIZE_OPS',
  comment: 'In-flight SGA resize operations',
  query() {
    return queryResult(
      [
        col.str('COMPONENT', 64),
        col.str('OPER_TYPE', 16),
        col.str('OPER_MODE', 12),
        col.str('PARAMETER', 64),
        col.num('INITIAL_SIZE'),
        col.num('TARGET_SIZE'),
        col.date('START_TIME'),
      ],
      []
    );
  },
});

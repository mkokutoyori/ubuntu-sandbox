/**
 * V$RECOVERY_PROGRESS — current recovery progress (empty when none).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RECOVERY_PROGRESS',
  comment: 'Recovery progress',
  query() {
    return queryResult(
      [
        col.date('START_TIME'),
        col.str('TYPE', 64),
        col.str('ITEM', 32),
        col.num('UNITS'),
        col.num('SOFAR'),
        col.num('TOTAL'),
        col.str('TIMESTAMP', 19),
      ],
      []
    );
  },
});

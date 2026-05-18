/**
 * V$MUTEX_SLEEP_HISTORY — historical mutex sleep events.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$MUTEX_SLEEP_HISTORY',
  comment: 'Per-event mutex sleep history',
  query() {
    return queryResult(
      [
        col.date('SLEEP_TIMESTAMP'),
        col.str('MUTEX_TYPE', 64),
        col.str('GETS', 16),
        col.str('SLEEPS', 16),
        col.num('REQUESTING_SESSION'),
        col.num('BLOCKING_SESSION'),
        col.str('LOCATION', 40),
        col.num('MUTEX_VALUE'),
      ],
      []
    );
  },
});

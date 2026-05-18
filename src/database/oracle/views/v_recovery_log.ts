/**
 * V$RECOVERY_LOG — archive logs the next recovery would need. Empty
 * because no recovery is in progress in our simulator.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$RECOVERY_LOG',
  comment: 'Logs required for recovery',
  query() {
    return queryResult(
      [
        col.num('THREAD#'),
        col.num('SEQUENCE#'),
        col.date('TIME'),
        col.str('ARCHIVE_NAME', 513),
      ],
      []
    );
  },
});

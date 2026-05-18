/**
 * V$SHARED_SERVER_MONITOR — shared server peak usage.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SHARED_SERVER_MONITOR',
  comment: 'Shared server peak / current usage',
  query() {
    return queryResult(
      [
        col.num('MAXIMUM_CONNECTIONS'),
        col.num('MAXIMUM_SESSIONS'),
        col.num('SERVERS_STARTED'),
        col.num('SERVERS_TERMINATED'),
        col.num('SERVERS_HIGHWATER'),
      ],
      [[0, 0, 0, 0, 0]]
    );
  },
});

/**
 * V$CIRCUIT — virtual circuits (shared-server). Empty by default.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$CIRCUIT',
  comment: 'Shared-server virtual circuits',
  query() {
    return queryResult(
      [
        col.str('CIRCUIT', 16),
        col.str('DISPATCHER', 16),
        col.str('SERVER', 16),
        col.num('WAITER'),
        col.str('SADDR', 16),
        col.str('STATUS', 16),
        col.str('QUEUE', 10),
        col.num('MESSAGES0'),
        col.num('MESSAGES1'),
        col.num('BYTES0'),
        col.num('BYTES1'),
      ],
      []
    );
  },
});

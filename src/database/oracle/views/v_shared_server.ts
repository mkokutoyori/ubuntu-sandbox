/**
 * V$SHARED_SERVER — shared server processes. Empty when only dedicated
 * server is configured.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SHARED_SERVER',
  comment: 'Shared server processes',
  query() {
    return queryResult(
      [
        col.str('NAME', 4),
        col.str('STATUS', 14),
        col.num('REQUESTS'),
        col.num('IDLE'),
        col.num('BUSY'),
      ],
      []
    );
  },
});

/**
 * V$QUEUE — shared-server request queues. Empty by default.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$QUEUE',
  comment: 'Shared-server request queues',
  query() {
    return queryResult(
      [
        col.str('PADDR', 16),
        col.str('TYPE', 10),
        col.str('QUEUED', 7),
        col.num('WAIT'),
        col.num('TOTALQ'),
      ],
      [
        ['0', 'COMMON', 'NONE', 0, 0],
        ['0', 'OUTBOUND', 'NONE', 0, 0],
      ]
    );
  },
});

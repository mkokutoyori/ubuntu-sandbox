/**
 * V$SESSION_OBJECT_CACHE — object cache stats per session.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESSION_OBJECT_CACHE',
  comment: 'Object cache stats per session',
  query({ runtime, storage }) {
    const objs = storage.getAllTables().length + storage.getAllViews().length;
    return queryResult(
      [
        col.num('PIN_HITS'),
        col.num('PINS'),
        col.num('TRUE_DEL'),
        col.num('LRU_DEL'),
        col.num('UNPINS'),
        col.num('UPDATES'),
        col.num('BLOCK_GETS'),
        col.num('CURRENT_OBJS'),
      ],
      [...runtime.sessions.values()].map(s => [
        runtime.counters.executions, runtime.counters.executions + objs,
        0, 0, runtime.counters.executions, runtime.counters.dml, 0, objs,
      ]).slice(0, 1) // V$SESSION_OBJECT_CACHE is per-session-of-caller; one row
    );
  },
});

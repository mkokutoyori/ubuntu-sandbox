/**
 * V$BUFFER_POOL_STATISTICS — buffer pool runtime stats.
 *
 * Cumulative reads come from the event-fed SQL cache (diskReads),
 * cumulative buffer-gets from bufferGets.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BUFFER_POOL_STATISTICS',
  comment: 'Buffer pool runtime statistics',
  query({ runtime }) {
    let bufGets = 0, diskReads = 0;
    for (const s of runtime.sqlCache.values()) {
      bufGets += s.bufferGets;
      diskReads += s.diskReads;
    }
    return queryResult(
      [
        col.num('ID'),
        col.str('NAME', 20),
        col.num('SET_MSIZE'),
        col.num('FREE_BUFFER_WAIT'),
        col.num('BUFFER_BUSY_WAIT'),
        col.num('PHYSICAL_READS'),
        col.num('PHYSICAL_WRITES'),
        col.num('DB_BLOCK_GETS'),
        col.num('CONSISTENT_GETS'),
        col.num('DB_BLOCK_CHANGE'),
      ],
      [[
        3, 'DEFAULT', 16384, 0, 0, diskReads, runtime.counters.commits * 4,
        bufGets, bufGets, runtime.counters.dml,
      ]]
    );
  },
});

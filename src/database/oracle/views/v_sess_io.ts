/**
 * V$SESS_IO — per-session I/O statistics.
 *
 * Derived from the SQL cache (which is itself populated by
 * oracle.sql.parsed / oracle.sql.executed). Reads & writes are scaled
 * by the session's share of executions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SESS_IO',
  comment: 'Per-session I/O counters',
  query({ runtime }) {
    const totals = { buf: 0, disk: 0, rows: 0 };
    for (const s of runtime.sqlCache.values()) {
      totals.buf += s.bufferGets;
      totals.disk += s.diskReads;
      totals.rows += s.rowsProcessed;
    }
    const n = Math.max(1, runtime.sessions.size);
    return queryResult(
      [
        col.num('SID'),
        col.num('BLOCK_GETS'),
        col.num('CONSISTENT_GETS'),
        col.num('PHYSICAL_READS'),
        col.num('BLOCK_CHANGES'),
        col.num('CONSISTENT_CHANGES'),
        col.num('OPTIMIZED_PHYSICAL_READS'),
      ],
      [...runtime.sessions.values()].map(s => [
        s.sid,
        Math.floor(totals.buf / n),
        Math.floor(totals.buf / n),
        Math.floor(totals.disk / n),
        Math.floor(runtime.counters.dml / n),
        Math.floor(runtime.counters.commits / n),
        0,
      ])
    );
  },
});

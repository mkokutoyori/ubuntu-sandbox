/**
 * V$SQL_MONITOR — currently-monitored SQL executions.
 *
 * Returns the most recent cached cursors with their event-fed timing.
 * Real Oracle filters by "long-running" thresholds; we surface up to 50
 * entries.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_MONITOR',
  comment: 'Real-time SQL monitor',
  query({ runtime }) {
    const sorted = [...runtime.sqlCache.values()]
      .sort((a, b) => b.lastLoadTime - a.lastLoadTime)
      .slice(0, 50);
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('SQL_EXEC_ID'),
        col.date('SQL_EXEC_START'),
        col.str('STATUS', 16),
        col.str('USERNAME', 30),
        col.num('ELAPSED_TIME'),
        col.num('CPU_TIME'),
        col.num('BUFFER_GETS'),
        col.num('DISK_READS'),
        col.num('PHYSICAL_READ_BYTES'),
      ],
      sorted.map((s, idx) => [
        s.sqlId, idx + 1,
        new Date(s.firstLoadTime).toISOString(),
        s.executions > 0 ? 'DONE' : 'EXECUTING',
        s.parsingSchema,
        s.elapsedMicros, s.cpuMicros,
        s.bufferGets, s.diskReads, s.diskReads * 8192,
      ])
    );
  },
});

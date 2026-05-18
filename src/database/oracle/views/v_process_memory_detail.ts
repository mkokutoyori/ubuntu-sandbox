/**
 * V$PROCESS_MEMORY_DETAIL — finer-grained PGA detail.
 *
 * One row per background process × heap component.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const HEAPS = ['session heap', 'cursor heap', 'PLSQL heap', 'work area heap'];

registerView({
  name: 'V$PROCESS_MEMORY_DETAIL',
  comment: 'Per-process PGA heap detail',
  query({ instance }) {
    const rows: (string | number)[][] = [];
    for (const p of instance.getBackgroundProcesses()) {
      for (const h of HEAPS) {
        rows.push([p.pid, p.pid, 'SQL', h, 64 * 1024, 256 * 1024]);
      }
    }
    return queryResult(
      [
        col.num('PID'),
        col.num('SERIAL#'),
        col.str('CATEGORY', 16),
        col.str('NAME', 64),
        col.num('BYTES'),
        col.num('ALLOCATION_COUNT'),
      ],
      rows
    );
  },
});

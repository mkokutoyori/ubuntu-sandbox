/**
 * V$ARCHIVE_PROCESSES — ARCn process states.
 *
 * Derived from the live background-process list (which itself reacts to
 * `oracle.instance.background-process-started/stopped`).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$ARCHIVE_PROCESSES',
  comment: 'ARCn process status',
  query({ instance }) {
    const procs = instance.getBackgroundProcesses().filter(p => p.name.startsWith('ARC'));
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 30; i++) {
      const p = procs[i];
      rows.push([
        i, p ? 'ACTIVE' : 'STOPPED', p ? 'BUSY' : 'IDLE',
        p?.name ?? '', p?.pid ?? 0,
      ]);
    }
    return queryResult(
      [
        col.num('PROCESS'),
        col.str('STATUS', 16),
        col.str('LOG_SEQUENCE', 16),
        col.str('PROCESS_NAME', 8),
        col.num('SPID'),
      ],
      rows
    );
  },
});

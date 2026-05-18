/**
 * V$THREADS — generic worker-thread inventory.
 *
 * Reflects the running background processes, which are maintained by
 * OracleInstance through the oracle.instance.background-process-started
 * / -stopped events.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$THREADS',
  comment: 'Generic process-thread inventory',
  query({ instance }) {
    const procs = instance.getBackgroundProcesses();
    return queryResult(
      [
        col.num('SID'),
        col.str('THREAD_TYPE', 16),
        col.num('TID'),
        col.str('STARTUP', 12),
      ],
      procs.map(p => [p.pid, 'BACKGROUND', p.pid, 'AT INSTANCE START'])
    );
  },
});

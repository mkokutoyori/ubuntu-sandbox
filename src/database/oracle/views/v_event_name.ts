/**
 * V$EVENT_NAME — catalogue of every wait event the kernel may report.
 *
 * This is the immutable Oracle catalogue (≈1900 events on a real
 * 19c instance); we surface a representative subset covering the
 * Wait Classes used by V$SYSTEM_EVENT / V$SESSION_WAIT etc.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

export const EVENT_CATALOGUE: ReadonlyArray<{
  id: number; name: string; waitClass: string; waitClassId: number; params: string[];
}> = [
  // Idle
  { id: 1, name: 'rdbms ipc message', waitClass: 'Idle', waitClassId: 6, params: ['timeout', '', ''] },
  { id: 2, name: 'SQL*Net message from client', waitClass: 'Idle', waitClassId: 6, params: ['driver id', '#bytes', ''] },
  { id: 3, name: 'pmon timer', waitClass: 'Idle', waitClassId: 6, params: ['duration', '', ''] },
  { id: 4, name: 'smon timer', waitClass: 'Idle', waitClassId: 6, params: ['sleep time', '', ''] },
  // User I/O
  { id: 10, name: 'db file sequential read', waitClass: 'User I/O', waitClassId: 8, params: ['file#', 'block#', 'blocks'] },
  { id: 11, name: 'db file scattered read', waitClass: 'User I/O', waitClassId: 8, params: ['file#', 'block#', 'blocks'] },
  { id: 12, name: 'direct path read', waitClass: 'User I/O', waitClassId: 8, params: ['file number', 'first dba', 'block cnt'] },
  // System I/O
  { id: 20, name: 'control file sequential read', waitClass: 'System I/O', waitClassId: 4, params: ['file#', 'block#', 'blocks'] },
  { id: 21, name: 'log file parallel write', waitClass: 'System I/O', waitClassId: 4, params: ['files', 'blocks', 'requests'] },
  { id: 22, name: 'db file parallel write', waitClass: 'System I/O', waitClassId: 4, params: ['requests', 'interrupt', 'timeout'] },
  // Commit
  { id: 30, name: 'log file sync', waitClass: 'Commit', waitClassId: 5, params: ['buffer#', 'sync scn', ''] },
  // Concurrency
  { id: 40, name: 'latch: cache buffers chains', waitClass: 'Concurrency', waitClassId: 2, params: ['address', 'number', 'tries'] },
  { id: 41, name: 'library cache pin', waitClass: 'Concurrency', waitClassId: 2, params: ['handle address', 'pin address', '100*loc#mode+nm'] },
  { id: 42, name: 'cursor: pin S', waitClass: 'Concurrency', waitClassId: 2, params: ['idn', 'value', ''] },
  // Application
  { id: 50, name: 'enq: TX - row lock contention', waitClass: 'Application', waitClassId: 1, params: ['name|mode', 'usn<<16 | slot', 'sequence'] },
  { id: 51, name: 'enq: TM - contention', waitClass: 'Application', waitClassId: 1, params: ['name|mode', 'object#', 'table/partition'] },
  // Network
  { id: 60, name: 'SQL*Net message to client', waitClass: 'Network', waitClassId: 7, params: ['driver id', '#bytes', ''] },
  // Other
  { id: 70, name: 'os thread startup', waitClass: 'Other', waitClassId: 0, params: ['', '', ''] },
  { id: 71, name: 'asynch descriptor resize', waitClass: 'Other', waitClassId: 0, params: ['outstanding #aio', 'current aio limit', 'new aio limit'] },
  // Cluster (would be active on RAC)
  { id: 80, name: 'gc current block 2-way', waitClass: 'Cluster', waitClassId: 3, params: ['', '', ''] },
];

registerView({
  name: 'V$EVENT_NAME',
  comment: 'Catalogue of wait events',
  query() {
    return queryResult(
      [
        col.num('EVENT#'),
        col.num('EVENT_ID'),
        col.str('NAME', 64),
        col.str('PARAMETER1', 64),
        col.str('PARAMETER2', 64),
        col.str('PARAMETER3', 64),
        col.str('WAIT_CLASS', 64),
        col.num('WAIT_CLASS#'),
        col.num('WAIT_CLASS_ID'),
      ],
      EVENT_CATALOGUE.map((e, idx) => [
        idx + 1, e.id, e.name, e.params[0], e.params[1], e.params[2],
        e.waitClass, e.waitClassId, e.waitClassId,
      ])
    );
  },
});

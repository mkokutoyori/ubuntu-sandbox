/**
 * V$SYSMETRIC — current per-minute / per-15s metric values.
 *
 * Synthesises values from the event-fed runtime counters; the begin/end
 * window is the last interval (default 15s for "instance" group).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

export const METRIC_CATALOGUE: ReadonlyArray<{ id: number; name: string; unit: string }> = [
  { id: 2000, name: 'CPU Usage Per Sec', unit: 'CentiSeconds Per Second' },
  { id: 2003, name: 'User Calls Per Sec', unit: 'Calls Per Second' },
  { id: 2007, name: 'Executions Per Sec', unit: 'Executes Per Second' },
  { id: 2017, name: 'User Commits Per Sec', unit: 'Commits Per Second' },
  { id: 2030, name: 'User Rollbacks Per Sec', unit: 'Rollbacks Per Second' },
  { id: 2058, name: 'Logical Reads Per Sec', unit: 'Reads Per Second' },
  { id: 2059, name: 'Physical Reads Per Sec', unit: 'Reads Per Second' },
  { id: 2062, name: 'DB Block Changes Per Sec', unit: 'Changes Per Second' },
  { id: 2075, name: 'Hard Parse Count Per Sec', unit: 'Parses Per Second' },
  { id: 2077, name: 'Total Parse Count Per Sec', unit: 'Parses Per Second' },
  { id: 2104, name: 'Average Active Sessions', unit: 'Active Sessions' },
  { id: 2118, name: 'Open Cursors Per Sec', unit: 'Cursors Per Second' },
  { id: 2148, name: 'Active Sessions', unit: 'Sessions' },
  { id: 2196, name: 'Network Traffic Volume Per Sec', unit: 'Bytes Per Second' },
];

registerView({
  name: 'V$SYSMETRIC',
  comment: 'Current sample of per-second metrics',
  query({ runtime }) {
    const intervalS = Math.max(15, Math.floor((Date.now() - runtime.startedAt) / 1000));
    const valueOf = (name: string): number => {
      switch (name) {
        case 'CPU Usage Per Sec': return Math.floor(runtime.counters.executions / intervalS);
        case 'User Calls Per Sec': return Math.floor(runtime.counters.parseTotal / intervalS);
        case 'Executions Per Sec': return Math.floor(runtime.counters.executions / intervalS);
        case 'User Commits Per Sec': return Math.floor(runtime.counters.commits / intervalS);
        case 'User Rollbacks Per Sec': return Math.floor(runtime.counters.rollbacks / intervalS);
        case 'Logical Reads Per Sec': {
          let n = 0; for (const s of runtime.sqlCache.values()) n += s.bufferGets;
          return Math.floor(n / intervalS);
        }
        case 'Physical Reads Per Sec': {
          let n = 0; for (const s of runtime.sqlCache.values()) n += s.diskReads;
          return Math.floor(n / intervalS);
        }
        case 'DB Block Changes Per Sec': return Math.floor(runtime.counters.dml / intervalS);
        case 'Hard Parse Count Per Sec': return Math.floor(runtime.counters.parseHard / intervalS);
        case 'Total Parse Count Per Sec': return Math.floor(runtime.counters.parseTotal / intervalS);
        case 'Average Active Sessions': return runtime.sessions.size;
        case 'Open Cursors Per Sec': return runtime.sqlCache.size;
        case 'Active Sessions': return runtime.sessions.size;
        default: return 0;
      }
    };
    const end = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.str('GROUP_ID', 16),
        col.num('METRIC_ID'),
        col.str('METRIC_NAME', 64),
        col.num('VALUE'),
        col.str('METRIC_UNIT', 64),
      ],
      METRIC_CATALOGUE.map(m => [
        new Date(end - intervalS * 1000).toISOString(),
        new Date(end).toISOString(),
        intervalS * 100, '2', m.id, m.name, valueOf(m.name), m.unit,
      ])
    );
  },
});

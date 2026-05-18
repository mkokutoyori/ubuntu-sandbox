/**
 * V$SESS_TIME_MODEL — per-session time model breakdown.
 *
 * Aggregated from the event-fed runtime counters (CPU = sum of cpuMicros
 * from the SQL cache populated by oracle.sql.executed, DB time = elapsed
 * micros, parse time tied to parseTotal). Each session sees its
 * proportional slice based on the live session count.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const STAT_IDS: Array<[number, string]> = [
  [3649082374, 'DB time'],
  [3712030189, 'DB CPU'],
  [1561673735, 'background elapsed time'],
  [4157170894, 'background cpu time'],
  [3539047145, 'sequence load elapsed time'],
  [2900462195, 'parse time elapsed'],
  [3128105146, 'hard parse elapsed time'],
  [281379108, 'sql execute elapsed time'],
  [1990376415, 'connection management call elapsed time'],
  [1431595225, 'PL/SQL execution elapsed time'],
];

registerView({
  name: 'V$SESS_TIME_MODEL',
  comment: 'Time model values per session',
  query({ runtime }) {
    let cpu = 0, elapsed = 0;
    for (const s of runtime.sqlCache.values()) {
      cpu += s.cpuMicros;
      elapsed += s.elapsedMicros;
    }
    const n = Math.max(1, runtime.sessions.size);
    const slice = (total: number) => Math.floor(total / n);
    const valueFor = (name: string): number => {
      switch (name) {
        case 'DB time': return slice(elapsed);
        case 'DB CPU': return slice(cpu);
        case 'background elapsed time': return slice(Math.floor(elapsed / 4));
        case 'background cpu time': return slice(Math.floor(cpu / 4));
        case 'parse time elapsed': return slice(runtime.counters.parseTotal * 50);
        case 'hard parse elapsed time': return slice(runtime.counters.parseHard * 100);
        case 'sql execute elapsed time': return slice(elapsed);
        case 'PL/SQL execution elapsed time': return slice(Math.floor(elapsed / 10));
        default: return 0;
      }
    };
    const rows: (string | number)[][] = [];
    for (const s of runtime.sessions.values()) {
      for (const [id, name] of STAT_IDS) {
        rows.push([s.sid, id, name, valueFor(name)]);
      }
    }
    return queryResult(
      [
        col.num('SID'),
        col.num('STAT_ID'),
        col.str('STAT_NAME', 64),
        col.num('VALUE'),
      ],
      rows
    );
  },
});

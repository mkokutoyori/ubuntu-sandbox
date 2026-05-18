/**
 * V$STATNAME — names and classes of every system statistic.
 *
 * Provides the catalogue shared by V$MYSTAT, V$SESSTAT, V$SYSSTAT —
 * each row is a `{ name, class, value(runtime) }` triple so dependent
 * views can compute the live value reactively without recomputing the
 * name list.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import type { OracleRuntimeState } from './OracleRuntimeState';

export interface SysstatDef {
  name: string;
  cls: number;
  value: (rt: OracleRuntimeState) => number;
}

/** Statistic class bitmask used by Oracle:
 *    1=user, 2=redo, 4=enqueue, 8=cache, 16=OS, 32=RAC, 64=SQL, 128=debug. */
export const SYSSTAT_DEFINITIONS: ReadonlyArray<SysstatDef> = [
  { name: 'logons cumulative', cls: 1, value: r => r.counters.logonsCumulative },
  { name: 'logons current', cls: 1, value: r => r.sessions.size },
  { name: 'opened cursors cumulative', cls: 1, value: r => r.counters.parseTotal },
  { name: 'opened cursors current', cls: 1, value: r => r.sqlCache.size },
  { name: 'user commits', cls: 1, value: r => r.counters.commits },
  { name: 'user rollbacks', cls: 1, value: r => r.counters.rollbacks },
  { name: 'user calls', cls: 1, value: r => r.counters.parseTotal },
  { name: 'recursive calls', cls: 1, value: r => r.counters.parseTotal * 2 },
  { name: 'session logical reads', cls: 8, value: r => bufferGets(r) },
  { name: 'physical reads', cls: 8, value: r => physicalReads(r) },
  { name: 'physical writes', cls: 8, value: r => Math.floor(r.counters.commits * 4) },
  { name: 'redo size', cls: 2, value: r => r.counters.commits * 1024 },
  { name: 'redo entries', cls: 2, value: r => r.counters.dml + r.counters.ddl },
  { name: 'sorts (memory)', cls: 64, value: r => r.counters.executions },
  { name: 'sorts (disk)', cls: 64, value: () => 0 },
  { name: 'table scan rows gotten', cls: 64, value: r => bufferGets(r) * 4 },
  { name: 'table scans (short tables)', cls: 64, value: r => r.counters.executions },
  { name: 'parse count (total)', cls: 64, value: r => r.counters.parseTotal },
  { name: 'parse count (hard)', cls: 64, value: r => r.counters.parseHard },
  { name: 'execute count', cls: 64, value: r => r.counters.executions },
  { name: 'bytes sent via SQL*Net to client', cls: 1, value: r => bufferGets(r) * 128 },
  { name: 'bytes received via SQL*Net from client', cls: 1, value: r => r.counters.parseTotal * 64 },
  { name: 'DB time', cls: 16, value: r => sumElapsed(r) },
  { name: 'redo log space requests', cls: 2, value: r => r.counters.redoSwitches },
  { name: 'archive log writes', cls: 2, value: r => r.counters.archiveLogs },
];

function bufferGets(r: OracleRuntimeState): number {
  let n = 0;
  for (const s of r.sqlCache.values()) n += s.bufferGets;
  return n;
}
function physicalReads(r: OracleRuntimeState): number {
  let n = 0;
  for (const s of r.sqlCache.values()) n += s.diskReads;
  return n;
}
function sumElapsed(r: OracleRuntimeState): number {
  let n = 0;
  for (const s of r.sqlCache.values()) n += s.elapsedMicros;
  return n;
}

registerView({
  name: 'V$STATNAME',
  comment: 'Names and classes of system statistics',
  query() {
    return queryResult(
      [col.num('STATISTIC#'), col.str('NAME', 64), col.num('CLASS'), col.num('STAT_ID')],
      SYSSTAT_DEFINITIONS.map((d, idx) => [idx, d.name, d.cls, idx])
    );
  },
});

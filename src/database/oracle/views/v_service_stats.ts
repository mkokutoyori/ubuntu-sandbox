/**
 * V$SERVICE_STATS — service-level statistics per service.
 *
 * Fed by `oracle.service.event` (service registry) + counters scaled by
 * the share of active services.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const STATS: Array<[number, string, string]> = [
  [1, 'user commits', 'SESSION'],
  [2, 'user rollbacks', 'SESSION'],
  [3, 'logons cumulative', 'SESSION'],
  [4, 'execute count', 'SESSION'],
  [5, 'parse count (total)', 'SESSION'],
  [6, 'parse count (hard)', 'SESSION'],
  [7, 'session logical reads', 'SESSION'],
  [8, 'physical reads', 'SESSION'],
];

registerView({
  name: 'V$SERVICE_STATS',
  comment: 'Per-service cumulative statistics',
  query({ runtime }) {
    const active = [...runtime.services.values()].filter(s => s.active);
    const n = Math.max(1, active.length);
    const totals: Record<string, number> = {
      'user commits': runtime.counters.commits,
      'user rollbacks': runtime.counters.rollbacks,
      'logons cumulative': runtime.counters.logonsCumulative,
      'execute count': runtime.counters.executions,
      'parse count (total)': runtime.counters.parseTotal,
      'parse count (hard)': runtime.counters.parseHard,
    };
    let bg = 0, dr = 0;
    for (const s of runtime.sqlCache.values()) { bg += s.bufferGets; dr += s.diskReads; }
    totals['session logical reads'] = bg;
    totals['physical reads'] = dr;
    const rows: (string | number)[][] = [];
    for (const svc of active) {
      for (const [statId, name, cls] of STATS) {
        rows.push([
          svc.name, statId, name, cls,
          Math.floor((totals[name] ?? 0) / n),
        ]);
      }
    }
    return queryResult(
      [
        col.str('SERVICE_NAME', 64),
        col.num('STAT_ID'),
        col.str('STAT_NAME', 64),
        col.str('STAT_CLASS', 16),
        col.num('VALUE'),
      ],
      rows
    );
  },
});

/**
 * V$ENQUEUE_STAT / V$ENQUEUE_STATISTICS — cumulative enqueue request stats.
 *
 * Aggregated from `runtime.locks` grouped by type. Each (type, request)
 * pair carries the count of acquired vs. waited requests.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import type { OracleRuntimeState } from './OracleRuntimeState';

export function enqueueStatRows(runtime: OracleRuntimeState): (string | number)[][] {
  const agg = new Map<string, { type: string; gets: number; waits: number }>();
  for (const l of runtime.locks) {
    const cur = agg.get(l.type);
    if (cur) {
      cur.gets++;
      if (l.block) cur.waits++;
    } else {
      agg.set(l.type, { type: l.type, gets: 1, waits: l.block ? 1 : 0 });
    }
  }
  return [...agg.values()].map(a => [
    a.type, 'OTHER',
    a.gets, a.gets - a.waits, a.waits, a.waits * 10, 0,
  ]);
}

registerView({
  name: 'V$ENQUEUE_STAT',
  comment: 'Enqueue request statistics',
  query({ runtime }) {
    return queryResult(
      [
        col.str('EQ_TYPE', 2),
        col.str('REQ_REASON', 64),
        col.num('TOTAL_REQ#'),
        col.num('SUCC_REQ#'),
        col.num('FAILED_REQ#'),
        col.num('CUM_WAIT_TIME'),
        col.num('EVENT#'),
      ],
      enqueueStatRows(runtime)
    );
  },
});

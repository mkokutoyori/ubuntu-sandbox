/**
 * V$SQL_WORKAREA_HISTOGRAM — work-area size histogram.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const BUCKETS: Array<[number, number]> = [
  [0, 1024], [1024, 65536], [65536, 1048576],
  [1048576, 16777216], [16777216, 268435456], [268435456, 4294967296],
];

registerView({
  name: 'V$SQL_WORKAREA_HISTOGRAM',
  comment: 'Histogram of work-area sizes',
  query({ runtime }) {
    const exec = runtime.counters.executions;
    return queryResult(
      [
        col.num('LOW_OPTIMAL_SIZE'),
        col.num('HIGH_OPTIMAL_SIZE'),
        col.num('OPTIMAL_EXECUTIONS'),
        col.num('ONEPASS_EXECUTIONS'),
        col.num('MULTIPASSES_EXECUTIONS'),
        col.num('TOTAL_EXECUTIONS'),
      ],
      BUCKETS.map(([lo, hi]) => {
        // Distribute proportionally so larger buckets see fewer executions.
        const slice = Math.floor(exec / (BUCKETS.length * Math.max(1, Math.log10(hi))));
        return [lo, hi, slice, 0, 0, slice];
      })
    );
  },
});

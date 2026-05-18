/**
 * V$IOFUNCMETRIC — per-I/O-function metrics snapshot.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const FUNCTIONS = ['LGWR', 'DBWR', 'ARCH', 'Direct Reads', 'Direct Writes', 'Buffer Cache Reads', 'Others'];

registerView({
  name: 'V$IOFUNCMETRIC',
  comment: 'I/O function metrics snapshot',
  query({ runtime }) {
    let reads = 0;
    for (const s of runtime.sqlCache.values()) reads += s.diskReads;
    const end = Date.now();
    return queryResult(
      [
        col.date('BEGIN_TIME'),
        col.date('END_TIME'),
        col.num('INTSIZE_CSEC'),
        col.str('FUNCTION_NAME', 32),
        col.num('SMALL_READ_MEGABYTES'),
        col.num('SMALL_WRITE_MEGABYTES'),
        col.num('LARGE_READ_MEGABYTES'),
        col.num('LARGE_WRITE_MEGABYTES'),
        col.num('NUMBER_OF_WAITS'),
        col.num('WAIT_TIME'),
      ],
      FUNCTIONS.map(name => [
        new Date(end - 60_000).toISOString(), new Date(end).toISOString(),
        6000, name,
        Math.floor((reads * 8) / FUNCTIONS.length / 1024),
        Math.floor((runtime.counters.commits * 4) / FUNCTIONS.length / 1024),
        0, 0, 0, 0,
      ])
    );
  },
});

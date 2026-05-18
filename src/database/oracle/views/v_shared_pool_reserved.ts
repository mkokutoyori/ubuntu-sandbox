/**
 * V$SHARED_POOL_RESERVED — shared pool reserved area stats.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SHARED_POOL_RESERVED',
  comment: 'Shared pool reserved memory statistics',
  query() {
    return queryResult(
      [
        col.num('FREE_SPACE'),
        col.num('AVG_FREE_SIZE'),
        col.num('FREE_COUNT'),
        col.num('MAX_FREE_SIZE'),
        col.num('USED_SPACE'),
        col.num('AVG_USED_SIZE'),
        col.num('USED_COUNT'),
        col.num('REQUESTS'),
        col.num('REQUEST_MISSES'),
        col.num('LAST_MISS_SIZE'),
        col.num('MAX_MISS_SIZE'),
        col.num('REQUEST_FAILURES'),
        col.num('LAST_FAILURE_SIZE'),
        col.num('ABORTED_REQUEST_THRESHOLD'),
        col.num('ABORTED_REQUESTS'),
        col.num('LAST_ABORTED_SIZE'),
      ],
      [[
        16 * 1024 * 1024, 16384, 1024, 8 * 1024 * 1024,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 4400, 0, 0,
      ]]
    );
  },
});

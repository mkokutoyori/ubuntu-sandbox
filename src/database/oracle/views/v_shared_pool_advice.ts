/**
 * V$SHARED_POOL_ADVICE — shared pool sizing advisor.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$SHARED_POOL_ADVICE',
  comment: 'Shared pool sizing advisor',
  query({ instance, runtime }) {
    const sz = bytes(instance.getParameter('shared_pool_size') ?? '256M');
    const parses = runtime.counters.parseTotal;
    return queryResult(
      [
        col.num('SHARED_POOL_SIZE_FOR_ESTIMATE'),
        col.num('SHARED_POOL_SIZE_FACTOR'),
        col.num('ESTD_LC_SIZE'),
        col.num('ESTD_LC_MEMORY_OBJECTS'),
        col.num('ESTD_LC_TIME_SAVED'),
        col.num('ESTD_LC_TIME_SAVED_FACTOR'),
      ],
      [0.5, 0.75, 1, 1.25, 1.5, 2].map(f => [
        sz * f, f, Math.floor(sz * f / 4), Math.floor(sz * f / 8192),
        parses * Math.min(f, 1) * 10, Math.min(f, 1),
      ])
    );
  },
});

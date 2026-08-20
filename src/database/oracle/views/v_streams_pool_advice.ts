/**
 * V$STREAMS_POOL_ADVICE — streams pool sizing advisor.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$STREAMS_POOL_ADVICE',
  comment: 'Streams pool advice',
  query({ instance }) {
    const sz = bytes(instance.getParameter('streams_pool_size') ?? '32M');
    return queryResult(
      [
        col.num('SIZE_FOR_ESTIMATE'),
        col.num('SIZE_FACTOR'),
        col.num('ESTD_SPILL_COUNT'),
        col.num('ESTD_SPILL_TIME'),
        col.num('ESTD_UNSPILL_COUNT'),
      ],
      [0.5, 0.75, 1, 1.25, 1.5, 2].map(f => [
        sz * f, f, Math.max(0, Math.floor(100 * (1 - f))),
        Math.max(0, Math.floor(50 * (1 - f))), 0,
      ])
    );
  },
});

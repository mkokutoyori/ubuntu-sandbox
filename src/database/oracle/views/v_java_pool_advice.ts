/**
 * V$JAVA_POOL_ADVICE — java pool sizing advisor.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$JAVA_POOL_ADVICE',
  comment: 'Java pool advice',
  query({ instance }) {
    const sz = bytes(instance.getParameter('java_pool_size') ?? '64M');
    return queryResult(
      [
        col.num('JAVA_POOL_SIZE_FOR_ESTIMATE'),
        col.num('JAVA_POOL_SIZE_FACTOR'),
        col.num('ESTD_LC_SIZE'),
        col.num('ESTD_LC_LOAD_TIME'),
        col.num('ESTD_LC_LOAD_TIME_FACTOR'),
      ],
      [0.5, 0.75, 1, 1.25, 1.5, 2].map(f => [
        sz * f, f, Math.floor(sz * f / 4), Math.floor(50 / Math.max(0.1, f)), 1 / Math.max(0.1, f),
      ])
    );
  },
});

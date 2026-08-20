/**
 * V$BUFFER_POOL — buffer pool configuration.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$BUFFER_POOL',
  comment: 'Buffer pool configuration',
  query({ instance }) {
    const sz = bytes(instance.getParameter('db_cache_size') ?? '128M');
    return queryResult(
      [
        col.num('ID'),
        col.str('NAME', 20),
        col.num('BLOCK_SIZE'),
        col.num('CURRENT_SIZE'),
        col.num('BUFFERS'),
        col.num('TARGET_SIZE'),
        col.num('TARGET_BUFFERS'),
      ],
      [
        [3, 'DEFAULT', 8192, sz, Math.floor(sz / 8192), sz, Math.floor(sz / 8192)],
      ]
    );
  },
});

/**
 * V$BUFFER_POOL — buffer pool configuration.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

function bytes(spec: string): number {
  const m = spec.match(/^(\d+)([KMG])?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  return unit === 'G' ? n * 1024 * 1024 * 1024 : unit === 'M' ? n * 1024 * 1024 : unit === 'K' ? n * 1024 : n;
}

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

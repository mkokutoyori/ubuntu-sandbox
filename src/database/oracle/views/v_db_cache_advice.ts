/**
 * V$DB_CACHE_ADVICE — buffer cache sizing advisor.
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
  name: 'V$DB_CACHE_ADVICE',
  comment: 'Buffer cache advice',
  query({ instance, runtime }) {
    const sz = bytes(instance.getParameter('db_cache_size') ?? '128M');
    let diskReads = 0;
    for (const s of runtime.sqlCache.values()) diskReads += s.diskReads;
    return queryResult(
      [
        col.num('ID'),
        col.str('NAME', 20),
        col.num('BLOCK_SIZE'),
        col.num('ADVICE_STATUS'),
        col.num('SIZE_FOR_ESTIMATE'),
        col.num('SIZE_FACTOR'),
        col.num('BUFFERS_FOR_ESTIMATE'),
        col.num('ESTD_PHYSICAL_READ_FACTOR'),
        col.num('ESTD_PHYSICAL_READS'),
      ],
      [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((f, i) => [
        3, 'DEFAULT', 8192, 1,
        sz * f, f, Math.floor(sz * f / 8192),
        1 / Math.max(0.1, f),
        Math.max(0, Math.floor(diskReads / Math.max(0.1, f))),
      ])
    );
  },
});

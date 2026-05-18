/**
 * V$PGASTAT — PGA memory statistics.
 *
 * `aggregate PGA target parameter` reads the instance config; the rest
 * are derived from event-fed runtime counters (executions, sql cache size).
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
  name: 'V$PGASTAT',
  comment: 'PGA memory statistics',
  query({ instance, runtime }) {
    const target = bytes(instance.getParameter('pga_aggregate_target') ?? '256M');
    const inUse = Math.min(target / 2, runtime.sqlCache.size * 64 * 1024);
    return queryResult(
      [col.str('NAME', 64), col.num('VALUE'), col.str('UNIT', 12)],
      [
        ['aggregate PGA target parameter', target, 'bytes'],
        ['aggregate PGA auto target', Math.floor(target * 0.9), 'bytes'],
        ['global memory bound', Math.floor(target * 0.1), 'bytes'],
        ['total PGA inuse', inUse, 'bytes'],
        ['total PGA allocated', Math.floor(inUse * 1.5), 'bytes'],
        ['maximum PGA allocated', Math.floor(inUse * 1.8), 'bytes'],
        ['total freeable PGA memory', Math.floor(inUse * 0.5), 'bytes'],
        ['process count', runtime.sessions.size + 8, ''],
        ['max processes count', 300, ''],
        ['PGA memory freed back to OS', 0, 'bytes'],
        ['total PGA used for auto workareas', Math.floor(inUse * 0.4), 'bytes'],
        ['cache hit percentage', 100, 'percent'],
      ]
    );
  },
});

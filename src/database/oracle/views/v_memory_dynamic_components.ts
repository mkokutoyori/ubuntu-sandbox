/**
 * V$MEMORY_DYNAMIC_COMPONENTS — automatic memory management components.
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
  name: 'V$MEMORY_DYNAMIC_COMPONENTS',
  comment: 'Automatic memory management components',
  query({ instance }) {
    const components: Array<[string, string]> = [
      ['shared pool', instance.getParameter('shared_pool_size') ?? '256M'],
      ['large pool', instance.getParameter('large_pool_size') ?? '32M'],
      ['java pool', instance.getParameter('java_pool_size') ?? '64M'],
      ['streams pool', instance.getParameter('streams_pool_size') ?? '0'],
      ['SGA Target', instance.getParameter('sga_target') ?? '512M'],
      ['DEFAULT buffer cache', instance.getParameter('db_cache_size') ?? '128M'],
      ['PGA Target', instance.getParameter('pga_aggregate_target') ?? '128M'],
    ];
    return queryResult(
      [
        col.str('COMPONENT', 64),
        col.num('CURRENT_SIZE'),
        col.num('MIN_SIZE'),
        col.num('MAX_SIZE'),
        col.num('USER_SPECIFIED_SIZE'),
        col.num('OPER_COUNT'),
        col.num('GRANULE_SIZE'),
      ],
      components.map(([name, val]) => {
        const sz = bytes(val);
        return [name, sz, sz, sz, sz, 0, 4 * 1024 * 1024];
      })
    );
  },
});

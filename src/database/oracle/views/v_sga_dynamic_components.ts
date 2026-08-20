/**
 * V$SGA_DYNAMIC_COMPONENTS — dynamically-resizable SGA components.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$SGA_DYNAMIC_COMPONENTS',
  comment: 'Dynamically-resizable SGA components',
  query({ instance }) {
    const components: Array<[string, string]> = [
      ['shared pool', instance.getParameter('shared_pool_size') ?? '256M'],
      ['large pool', instance.getParameter('large_pool_size') ?? '32M'],
      ['java pool', instance.getParameter('java_pool_size') ?? '64M'],
      ['streams pool', instance.getParameter('streams_pool_size') ?? '0'],
      ['DEFAULT buffer cache', instance.getParameter('db_cache_size') ?? '128M'],
      ['ASM Buffer Cache', '0'],
    ];
    return queryResult(
      [
        col.str('COMPONENT', 64),
        col.num('CURRENT_SIZE'),
        col.num('MIN_SIZE'),
        col.num('MAX_SIZE'),
        col.num('USER_SPECIFIED_SIZE'),
        col.num('OPER_COUNT'),
        col.num('LAST_OPER_TYPE'),
        col.num('GRANULE_SIZE'),
      ],
      components.map(([name, val]) => {
        const sz = bytes(val);
        return [name, sz, sz, sz, sz, 0, 0, 4 * 1024 * 1024];
      })
    );
  },
});

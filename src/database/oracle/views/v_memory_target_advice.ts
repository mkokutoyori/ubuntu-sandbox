/**
 * V$MEMORY_TARGET_ADVICE — advice on memory_target sizing.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { parseSize as bytes } from './_fileSize';

registerView({
  name: 'V$MEMORY_TARGET_ADVICE',
  comment: 'Memory target sizing advisor',
  query({ instance }) {
    const sga = bytes(instance.getParameter('sga_target') ?? '512M');
    const pga = bytes(instance.getParameter('pga_aggregate_target') ?? '128M');
    const base = sga + pga;
    return queryResult(
      [
        col.num('MEMORY_SIZE'),
        col.num('MEMORY_SIZE_FACTOR'),
        col.num('ESTD_DB_TIME'),
        col.num('ESTD_DB_TIME_FACTOR'),
        col.num('VERSION'),
      ],
      [0.5, 0.75, 1, 1.25, 1.5, 2].map(f => [
        base * f, f,
        Math.floor(2000 / Math.max(0.1, f)),
        1 / Math.max(0.1, f),
        0,
      ])
    );
  },
});

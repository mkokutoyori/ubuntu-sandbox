/**
 * V$SGA_TARGET_ADVICE — SGA sizing advisor.
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
  name: 'V$SGA_TARGET_ADVICE',
  comment: 'SGA target sizing advisor',
  query({ instance }) {
    const target = bytes(instance.getParameter('sga_target') ?? '512M');
    return queryResult(
      [
        col.num('SGA_SIZE'),
        col.num('SGA_SIZE_FACTOR'),
        col.num('ESTD_DB_TIME'),
        col.num('ESTD_DB_TIME_FACTOR'),
        col.num('ESTD_PHYSICAL_READS'),
      ],
      [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map(f => [
        target * f, f,
        Math.floor(1000 / Math.max(0.1, f)),
        1 / Math.max(0.1, f),
        Math.floor(1000 / Math.max(0.1, f)),
      ])
    );
  },
});

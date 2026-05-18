/**
 * V$SGA_DYNAMIC_FREE_MEMORY — free SGA reserve for dynamic resizing.
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
  name: 'V$SGA_DYNAMIC_FREE_MEMORY',
  comment: 'Free SGA reserve',
  query({ instance }) {
    const max = bytes(instance.getParameter('sga_max_size') ?? '1G');
    const target = bytes(instance.getParameter('sga_target') ?? '512M');
    return queryResult(
      [col.num('CURRENT_SIZE')],
      [[Math.max(0, max - target)]]
    );
  },
});

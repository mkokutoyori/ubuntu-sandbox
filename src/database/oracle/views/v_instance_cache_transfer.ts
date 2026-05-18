/**
 * V$INSTANCE_CACHE_TRANSFER — global-cache block transfer stats.
 *
 * In a real RAC cluster this is fed by the Global Cache Service every
 * time a block changes ownership. We simulate a single-instance
 * database, so the only meaningful row is the empty "no remote
 * transfer happened" state for this instance.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$INSTANCE_CACHE_TRANSFER',
  comment: 'Global cache block transfer statistics per remote instance',
  query() {
    return queryResult(
      [
        col.num('INSTANCE'),
        col.str('CLASS', 18),
        col.num('LOST'),
        col.num('CR_BLOCK'),
        col.num('CR_BUSY'),
        col.num('CR_CONGESTED'),
        col.num('CURRENT_BLOCK'),
        col.num('CURRENT_BUSY'),
        col.num('CURRENT_CONGESTED'),
      ],
      [[1, 'data block', 0, 0, 0, 0, 0, 0, 0]]
    );
  },
});

/**
 * V$LATCH_PARENT — parent latch statistics.
 *
 * Same projection as V$LATCH but with the parent address.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { LATCH_CATALOGUE } from './v_latchname';

registerView({
  name: 'V$LATCH_PARENT',
  comment: 'Parent latch statistics',
  query() {
    return queryResult(
      [
        col.num('ADDR'),
        col.num('LATCH#'),
        col.num('LEVEL#'),
        col.str('NAME', 64),
        col.num('GETS'),
        col.num('MISSES'),
        col.num('SLEEPS'),
      ],
      LATCH_CATALOGUE.map(l => [l.id, l.id, l.level, l.name, 0, 0, 0])
    );
  },
});

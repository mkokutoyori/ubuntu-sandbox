/**
 * V$LATCH_CHILDREN — child latches with per-child stats.
 *
 * Each parent latch can have multiple children (in real Oracle there
 * can be 1024 cache buffers chains latches). We emit a small fixed
 * subset (4 children per parent) for diagnostics.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { LATCH_CATALOGUE } from './v_latchname';

const CHILDREN_PER = 4;

registerView({
  name: 'V$LATCH_CHILDREN',
  comment: 'Latch children statistics',
  query() {
    const rows: (string | number)[][] = [];
    for (const l of LATCH_CATALOGUE) {
      for (let c = 0; c < CHILDREN_PER; c++) {
        rows.push([l.id * 10 + c, l.id, c, l.level, l.name, 0, 0, 0]);
      }
    }
    return queryResult(
      [
        col.num('ADDR'),
        col.num('LATCH#'),
        col.num('CHILD#'),
        col.num('LEVEL#'),
        col.str('NAME', 64),
        col.num('GETS'),
        col.num('MISSES'),
        col.num('SLEEPS'),
      ],
      rows
    );
  },
});

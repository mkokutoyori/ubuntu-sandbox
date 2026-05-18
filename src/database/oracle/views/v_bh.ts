/**
 * V$BH — buffer cache headers per block.
 *
 * In a real Oracle the buffer cache holds one row per cached block; we
 * surface one row per table tracked by storage (a coarse proxy). The
 * STATUS is 'xcur' for current consistent blocks.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BH',
  comment: 'Buffer cache header view',
  query({ storage }) {
    const tables = storage.getAllTables();
    return queryResult(
      [
        col.num('FILE#'),
        col.num('BLOCK#'),
        col.num('CLASS#'),
        col.str('STATUS', 6),
        col.num('OBJD'),
        col.num('TS#'),
      ],
      tables.map((t, i) => [1, i + 100, 1, 'xcur', 1000 + i, 0])
    );
  },
});

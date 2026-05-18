/**
 * V$COPY_CORRUPTION — corrupt blocks in datafile copies.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$COPY_CORRUPTION',
  comment: 'Corrupt blocks in image copies',
  query() {
    return queryResult(
      [
        col.num('RECID'),
        col.num('FILE#'),
        col.num('BLOCK#'),
        col.num('BLOCKS'),
        col.str('CORRUPTION_TYPE', 9),
      ],
      []
    );
  },
});

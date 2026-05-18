/**
 * V$DATABASE_BLOCK_CORRUPTION — corrupt blocks discovered in the live database.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$DATABASE_BLOCK_CORRUPTION',
  comment: 'Persistent block corruption registry',
  query() {
    return queryResult(
      [
        col.num('FILE#'),
        col.num('BLOCK#'),
        col.num('BLOCKS'),
        col.num('CORRUPTION_CHANGE#'),
        col.str('CORRUPTION_TYPE', 9),
      ],
      []
    );
  },
});

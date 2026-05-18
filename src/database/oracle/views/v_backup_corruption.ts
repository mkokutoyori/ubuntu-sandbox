/**
 * V$BACKUP_CORRUPTION — corrupt blocks discovered during backups.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$BACKUP_CORRUPTION',
  comment: 'Corrupt blocks discovered during backups',
  query() {
    return queryResult(
      [
        col.num('RECID'),
        col.num('SET_STAMP'),
        col.num('PIECE#'),
        col.num('FILE#'),
        col.num('BLOCK#'),
        col.num('BLOCKS'),
        col.num('CORRUPTION_CHANGE#'),
        col.str('MARKED_CORRUPT', 3),
        col.str('CORRUPTION_TYPE', 9),
      ],
      []
    );
  },
});

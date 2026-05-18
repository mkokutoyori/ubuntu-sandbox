/**
 * DBA_IND_SUBPARTITIONS — composite index subpartitions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_IND_SUBPARTITIONS',
  comment: 'Index subpartitions',
  query() {
    return queryResult(
      [
        col.str('INDEX_OWNER', 30),
        col.str('INDEX_NAME', 30),
        col.str('PARTITION_NAME', 30),
        col.str('SUBPARTITION_NAME', 30),
        col.str('STATUS', 8),
      ],
      []
    );
  },
});

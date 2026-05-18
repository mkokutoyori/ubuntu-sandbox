/**
 * DBA_PART_INDEXES — partitioned indexes.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PART_INDEXES',
  comment: 'Partitioned indexes',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('INDEX_NAME', 30),
        col.str('TABLE_NAME', 30),
        col.str('PARTITIONING_TYPE', 9),
        col.num('PARTITION_COUNT'),
        col.str('LOCALITY', 6),
      ],
      []
    );
  },
});

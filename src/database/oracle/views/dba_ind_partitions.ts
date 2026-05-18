/**
 * DBA_IND_PARTITIONS — index partitions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_IND_PARTITIONS',
  comment: 'Index partitions',
  query() {
    return queryResult(
      [
        col.str('INDEX_OWNER', 30),
        col.str('INDEX_NAME', 30),
        col.str('PARTITION_NAME', 30),
        col.str('STATUS', 8),
        col.str('TABLESPACE_NAME', 30),
      ],
      []
    );
  },
});

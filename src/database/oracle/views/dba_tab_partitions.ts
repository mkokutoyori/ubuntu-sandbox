/**
 * DBA_TAB_PARTITIONS — partitioned table partitions. Empty unless
 * partitioning is used.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_PARTITIONS',
  comment: 'Table partitions',
  query() {
    return queryResult(
      [
        col.str('TABLE_OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('PARTITION_NAME', 30),
        col.str('SUBPARTITION_COUNT', 16),
        col.str('HIGH_VALUE', 4000),
        col.num('PARTITION_POSITION'),
        col.str('TABLESPACE_NAME', 30),
        col.num('NUM_ROWS'),
      ],
      []
    );
  },
});

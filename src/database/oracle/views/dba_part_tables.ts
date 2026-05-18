/**
 * DBA_PART_TABLES — partitioned tables (empty by default).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PART_TABLES',
  comment: 'Partitioned tables',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('PARTITIONING_TYPE', 9),
        col.str('SUBPARTITIONING_TYPE', 9),
        col.num('PARTITION_COUNT'),
        col.num('DEF_SUBPARTITION_COUNT'),
        col.num('PARTITIONING_KEY_COUNT'),
      ],
      []
    );
  },
});

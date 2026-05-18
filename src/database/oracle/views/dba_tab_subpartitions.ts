/**
 * DBA_TAB_SUBPARTITIONS — composite subpartitions.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_SUBPARTITIONS',
  comment: 'Composite-partition table subpartitions',
  query() {
    return queryResult(
      [
        col.str('TABLE_OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('PARTITION_NAME', 30),
        col.str('SUBPARTITION_NAME', 30),
        col.str('HIGH_VALUE', 4000),
        col.num('SUBPARTITION_POSITION'),
        col.str('TABLESPACE_NAME', 30),
      ],
      []
    );
  },
});

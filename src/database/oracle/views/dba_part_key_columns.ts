/**
 * DBA_PART_KEY_COLUMNS — partition key columns.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_PART_KEY_COLUMNS',
  comment: 'Partition key columns',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('NAME', 30),
        col.str('OBJECT_TYPE', 5),
        col.str('COLUMN_NAME', 30),
        col.num('COLUMN_POSITION'),
      ],
      []
    );
  },
});

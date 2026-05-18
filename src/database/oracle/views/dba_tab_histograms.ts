/**
 * DBA_TAB_HISTOGRAMS — column value histograms.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_HISTOGRAMS',
  comment: 'Column value histograms',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('COLUMN_NAME', 30),
        col.num('ENDPOINT_NUMBER'),
        col.str('ENDPOINT_VALUE', 100),
        col.str('ENDPOINT_ACTUAL_VALUE', 1000),
      ],
      []
    );
  },
});

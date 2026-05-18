/**
 * DBA_LIBRARIES — external libraries registered with the database.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_LIBRARIES',
  comment: 'External libraries',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('LIBRARY_NAME', 30),
        col.str('FILE_SPEC', 2000),
        col.str('DYNAMIC', 1),
        col.str('STATUS', 7),
      ],
      []
    );
  },
});

/**
 * DBA_MVIEW_LOGS — materialised view logs.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_MVIEW_LOGS',
  comment: 'Materialised view logs',
  query() {
    return queryResult(
      [
        col.str('LOG_OWNER', 30),
        col.str('MASTER', 30),
        col.str('LOG_TABLE', 30),
        col.str('LOG_TRIGGER', 30),
        col.str('ROWIDS', 3),
        col.str('PRIMARY_KEY', 3),
        col.str('OBJECT_ID', 3),
      ],
      []
    );
  },
});

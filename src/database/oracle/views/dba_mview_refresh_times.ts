/**
 * DBA_MVIEW_REFRESH_TIMES — last refresh of each MV.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_MVIEW_REFRESH_TIMES',
  comment: 'Materialised view last-refresh times',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('NAME', 30),
        col.str('MASTER_OWNER', 30),
        col.str('MASTER', 30),
        col.date('LAST_REFRESH'),
      ],
      []
    );
  },
});

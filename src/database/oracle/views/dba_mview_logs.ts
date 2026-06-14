/**
 * DBA_MVIEW_LOGS — materialised view logs, read from the live registry.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_MVIEW_LOGS',
  comment: 'Materialised view logs',
  query({ catalog }) {
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
      catalog.getMviewLogs().map(l => [
        l.owner, l.master, l.logTable, null,
        l.withRowid ? 'YES' : 'NO',
        l.withPrimaryKey ? 'YES' : 'NO',
        'NO',
      ]),
    );
  },
});

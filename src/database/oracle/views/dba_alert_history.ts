/**
 * DBA_ALERT_HISTORY — historical alerts (cleared and outstanding).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ALERT_HISTORY',
  comment: 'Alert history',
  query({ runtime }) {
    return queryResult(
      [
        col.num('SEQUENCE_ID'),
        col.str('REASON_ID', 32),
        col.str('SEVERITY', 11),
        col.date('CREATION_TIME'),
        col.date('RESOLUTION_TIME'),
        col.str('MESSAGE', 4000),
      ],
      runtime.alertEntries.map((e, idx) => [
        idx + 1, /ORA-/.test(e.line) ? 'Error' : 'Info',
        /ORA-/.test(e.line) ? 'CRITICAL' : 'NORMAL',
        new Date(e.ts).toISOString(),
        new Date(e.ts + 1000).toISOString(),
        e.line,
      ])
    );
  },
});

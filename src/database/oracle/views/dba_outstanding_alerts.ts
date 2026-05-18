/**
 * DBA_OUTSTANDING_ALERTS — currently-outstanding server alerts.
 *
 * Derived from the runtime alert-log entries (event-fed via
 * oracle.instance.alert-log-entry-added). We classify ORA-error lines
 * as "Outstanding" alerts.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_OUTSTANDING_ALERTS',
  comment: 'Outstanding server alerts',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    runtime.alertEntries.forEach((entry, idx) => {
      if (!/ORA-/.test(entry.line)) return;
      rows.push([
        idx + 1, 'Outstanding', 'CRITICAL', 'Database',
        new Date(entry.ts).toISOString(), entry.line,
      ]);
    });
    return queryResult(
      [
        col.num('SEQUENCE_ID'),
        col.str('REASON_ID', 32),
        col.str('SEVERITY', 11),
        col.str('OBJECT_TYPE', 50),
        col.date('CREATION_TIME'),
        col.str('MESSAGE', 4000),
      ],
      rows
    );
  },
});

/**
 * DBA_OUTSTANDING_ALERTS — currently-outstanding server alerts.
 *
 * Combines (a) ORA-error lines mined from the alert log and (b) every
 * security anomaly raised by the SecurityAuditActor that hasn't been
 * acknowledged. The latter use REASON_ID = the anomaly kind so DBAs
 * can filter `WHERE REASON_ID LIKE 'PRIVILEGE%'` etc.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_OUTSTANDING_ALERTS',
  comment: 'Outstanding server alerts',
  query({ runtime, instance }) {
    const rows: (string | number)[][] = [];
    runtime.alertEntries.forEach((entry, idx) => {
      if (!/ORA-/.test(entry.line)) return;
      rows.push([
        idx + 1, 'Outstanding', 'CRITICAL', 'Database',
        new Date(entry.ts).toISOString(), entry.line,
      ]);
    });
    let seq = runtime.alertEntries.length + 1;
    for (const a of instance.getAuditJournal().getAnomalies()) {
      if ((a as { acknowledged?: boolean }).acknowledged) continue;
      rows.push([
        seq++, a.kind, a.severity, 'Security',
        a.timestamp.toISOString(), a.description,
      ]);
    }
    return queryResult(
      [
        col.num('SEQUENCE_ID'),
        col.str('REASON_ID', 32),
        col.str('SEVERITY', 11),
        col.str('OBJECT_TYPE', 50),
        col.date('CREATION_TIME'),
        col.str('MESSAGE', 4000),
      ],
      rows,
    );
  },
});

/**
 * DBA_ALERT_HISTORY — historical alerts (cleared and outstanding).
 *
 * Includes both alert-log derived rows and every security anomaly
 * detected by the SecurityAuditActor. Anomaly RESOLUTION_TIME is
 * populated when the operator has acknowledged the anomaly.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_ALERT_HISTORY',
  comment: 'Alert history',
  query({ runtime, instance }) {
    const rows: (string | number | null)[][] = [];
    runtime.alertEntries.forEach((e, idx) => {
      rows.push([
        idx + 1, /ORA-/.test(e.line) ? 'Error' : 'Info',
        /ORA-/.test(e.line) ? 'CRITICAL' : 'NORMAL',
        new Date(e.ts).toISOString(),
        new Date(e.ts + 1000).toISOString(),
        e.line,
      ]);
    });
    let seq = runtime.alertEntries.length + 1;
    for (const a of instance.getAuditJournal().getAnomalies()) {
      const ack = (a as { acknowledged?: boolean; acknowledgedAt?: Date | null });
      rows.push([
        seq++, a.kind, a.severity,
        a.timestamp.toISOString(),
        ack.acknowledged && ack.acknowledgedAt ? ack.acknowledgedAt.toISOString() : null,
        a.description,
      ]);
    }
    return queryResult(
      [
        col.num('SEQUENCE_ID'),
        col.str('REASON_ID', 32),
        col.str('SEVERITY', 11),
        col.date('CREATION_TIME'),
        col.date('RESOLUTION_TIME'),
        col.str('MESSAGE', 4000),
      ],
      rows,
    );
  },
});

/**
 * DBA_AUDIT_SESSION — LOGON / LOGOFF audit entries.
 *
 * Pairs LOGON entries with their matching LOGOFF (by sessionId) so
 * LOGOFF_TIME is populated for closed sessions and NULL for sessions
 * still active. Failed logons appear with RETURNCODE != 0.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_AUDIT_SESSION',
  comment: 'Session-level audit trail',
  query({ catalog }) {
    const trail = catalog.getAuditTrail();
    const logoffs = new Map<number, typeof trail[number]>();
    for (const e of trail) if (e.actionName === 'LOGOFF') logoffs.set(e.sessionId, e);

    const rows: (string | number | null)[][] = [];
    for (const e of trail) {
      if (e.actionName !== 'LOGON') continue;
      const off = logoffs.get(e.sessionId);
      rows.push([
        e.osUsername, e.username, e.userhost, e.terminal,
        e.timestamp.toISOString(), 'LOGON', e.sessionId,
        off ? off.timestamp.toISOString() : null,
        e.returncode,
      ]);
    }
    for (const off of logoffs.values()) {
      rows.push([
        off.osUsername, off.username, off.userhost, off.terminal,
        off.timestamp.toISOString(), 'LOGOFF', off.sessionId,
        off.timestamp.toISOString(),
        off.returncode,
      ]);
    }
    return queryResult(
      [
        col.str('OS_USERNAME', 30),
        col.str('USERNAME', 128),
        col.str('USERHOST', 128),
        col.str('TERMINAL', 128),
        col.date('TIMESTAMP'),
        col.str('ACTION_NAME', 28),
        col.num('SESSIONID'),
        col.date('LOGOFF_TIME'),
        col.num('RETURNCODE'),
      ],
      rows
    );
  },
});

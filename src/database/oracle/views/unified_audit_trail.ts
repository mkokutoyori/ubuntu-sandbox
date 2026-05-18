/**
 * UNIFIED_AUDIT_TRAIL — unified audit trail (12c+ unified auditing).
 *
 * Fed by the runtime alert log (ORA-* entries) and session lifecycle.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'UNIFIED_AUDIT_TRAIL',
  comment: 'Unified audit trail',
  query({ runtime }) {
    const rows: (string | number)[][] = [];
    // Sessions
    for (const s of runtime.sessions.values()) {
      rows.push([
        new Date(s.logonTime).toISOString(), 'STANDARD',
        s.username, 'localhost', 'oracle', 'LOGON',
        s.sid, 0, null as unknown as string, null as unknown as string,
      ]);
    }
    // Errors
    runtime.alertEntries
      .filter(e => /ORA-/.test(e.line))
      .forEach((e, idx) => {
        rows.push([
          new Date(e.ts).toISOString(), 'STANDARD',
          'SYS', 'localhost', 'oracle', 'ERROR',
          idx + 1, 1, e.line, null as unknown as string,
        ]);
      });
    return queryResult(
      [
        col.date('EVENT_TIMESTAMP'),
        col.str('AUDIT_TYPE', 64),
        col.str('DBUSERNAME', 128),
        col.str('USERHOST', 128),
        col.str('OS_USER', 128),
        col.str('ACTION_NAME', 28),
        col.num('SESSIONID'),
        col.num('RETURN_CODE'),
        col.str('SQL_TEXT', 2000),
        col.str('OBJECT_NAME', 128),
      ],
      rows
    );
  },
});

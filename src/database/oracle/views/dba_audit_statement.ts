/**
 * DBA_AUDIT_STATEMENT — statement-level audit events.
 *
 * Filters the catalog audit trail down to statements that don't target
 * a specific object (CREATE/ALTER/DROP USER, CREATE ROLE, ALTER SYSTEM,
 * AUDIT, NOAUDIT, …). LOGON/LOGOFF are reported by DBA_AUDIT_SESSION
 * and intentionally excluded here.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const STATEMENT_ACTIONS = new Set([
  'CREATE USER', 'ALTER USER', 'DROP USER',
  'CREATE ROLE', 'ALTER ROLE', 'DROP ROLE',
  'CREATE PROFILE', 'ALTER PROFILE', 'DROP PROFILE',
  'CREATE TABLESPACE', 'ALTER TABLESPACE', 'DROP TABLESPACE',
  'ALTER SYSTEM', 'ALTER DATABASE',
  'AUDIT', 'NOAUDIT',
  'AUDIT STATEMENT', 'NOAUDIT STATEMENT',
  'GRANT', 'REVOKE',
]);

registerView({
  name: 'DBA_AUDIT_STATEMENT',
  comment: 'Statement-level audit trail',
  query({ catalog }) {
    const trail = catalog.getAuditTrail();
    const rows: (string | number | null)[][] = [];
    for (const e of trail) {
      if (!STATEMENT_ACTIONS.has(e.actionName)) continue;
      rows.push([
        e.osUsername, e.username, e.userhost, e.terminal,
        e.timestamp.toISOString(), e.actionName,
        e.objName, e.sqlText, e.returncode, e.sessionId,
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
        col.str('OBJ_NAME', 128),
        col.str('SQL_TEXT', 2000),
        col.num('RETURNCODE'),
        col.num('SESSIONID'),
      ],
      rows
    );
  },
});

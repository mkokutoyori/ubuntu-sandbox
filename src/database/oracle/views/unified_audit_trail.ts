/**
 * UNIFIED_AUDIT_TRAIL — unified audit trail (12c+ unified auditing).
 *
 * Surfaces every audit event the catalog has recorded — LOGON, LOGOFF,
 * DDL, DCL, DML configured for auditing, and FGA hits. Failed logons
 * (RETURNCODE != 0) are included so a DBA can correlate ORA-01017 alerts
 * with their unified audit row.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'UNIFIED_AUDIT_TRAIL',
  comment: 'Unified audit trail',
  query({ catalog }) {
    const rows: (string | number | null)[][] = [];
    let entryId = 1;
    for (const e of catalog.getAuditTrail()) {
      rows.push([
        e.timestamp.toISOString(),                           // EVENT_TIMESTAMP
        'Standard',                                          // AUDIT_TYPE
        e.sessionId,                                         // SESSIONID
        e.username,                                          // DBUSERNAME
        e.userhost,                                          // USERHOST
        e.terminal,                                          // TERMINAL
        e.osUsername,                                        // OS_USER
        e.actionName,                                        // ACTION_NAME
        e.returncode,                                        // RETURN_CODE
        e.sqlText,                                           // SQL_TEXT
        e.objOwner,                                          // OBJECT_SCHEMA
        e.objName,                                           // OBJECT_NAME
        e.statementType,                                     // STATEMENT_TYPE
        e.privUsed,                                          // SYSTEM_PRIVILEGE_USED
        entryId++,                                           // ENTRY_ID
      ]);
    }
    // FGA records are part of the unified trail too.
    for (const f of catalog.getFgaTrail()) {
      rows.push([
        f.timestamp.toISOString(), 'FineGrainedAudit', f.sessionId,
        f.dbUser, 'localhost', 'pts/0', f.osUser,
        f.statementType, 0, f.sqlText,
        f.objectSchema, f.objectName, f.statementType,
        f.policyName, entryId++,
      ]);
    }
    return queryResult(
      [
        col.date('EVENT_TIMESTAMP'),
        col.str('AUDIT_TYPE', 64),
        col.num('SESSIONID'),
        col.str('DBUSERNAME', 128),
        col.str('USERHOST', 128),
        col.str('TERMINAL', 128),
        col.str('OS_USER', 128),
        col.str('ACTION_NAME', 28),
        col.num('RETURN_CODE'),
        col.str('SQL_TEXT', 2000),
        col.str('OBJECT_SCHEMA', 128),
        col.str('OBJECT_NAME', 128),
        col.str('STATEMENT_TYPE', 28),
        col.str('SYSTEM_PRIVILEGE_USED', 100),
        col.num('ENTRY_ID'),
      ],
      rows
    );
  },
});

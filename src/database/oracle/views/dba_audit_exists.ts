/**
 * DBA_AUDIT_EXISTS — actions audited specifically because they raised
 * an ORA-01034 / ORA-01017 / ORA-01045 error (insufficient privileges
 * or "object does not exist" errors when AUDIT NOT EXISTS is enabled).
 * Native Oracle 9i+.
 *
 * The simulator picks every audit-trail row whose RETURNCODE is one
 * of the privilege/object-existence error codes — that is the precise
 * filter real Oracle applies for this view.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const FAIL_CODES = new Set([942, 1031, 1017, 1045, 28000, 1918, 1920, 942, 4042, 6550]);

registerView({
  name: 'DBA_AUDIT_EXISTS',
  comment: 'Audited statements rejected by privilege/existence checks',
  query({ catalog }) {
    const rows: (string | number | null)[][] = [];
    for (const e of catalog.getAuditTrail()) {
      if (e.returncode === 0 || !FAIL_CODES.has(e.returncode)) continue;
      rows.push([
        e.osUsername, e.username, e.userhost, e.terminal,
        e.timestamp.toISOString(), null,                     // OWNER
        e.objName, e.actionName, null,                       // NEW_OWNER
        null,                                                // NEW_NAME
        e.objOwner, null,                                    // SES_ACTIONS
        e.timestamp.toISOString(),                           // LOGOFF_TIME
        null, null, null, null,                              // LOGOFF_LREAD/PREAD/LWRITE/DLOCK
        null,                                                // COMMENT_TEXT
        e.sessionId, 0,                                      // SESSIONID, ENTRYID
        e.returncode,                                        // RETURNCODE
        e.privUsed,                                          // PRIV_USED
        null,                                                // CLIENT_ID
        null,                                                // SCN
        e.sqlText,
      ]);
    }
    return queryResult(
      [
        col.str('OS_USERNAME', 128),
        col.str('USERNAME', 128),
        col.str('USERHOST', 128),
        col.str('TERMINAL', 30),
        col.date('TIMESTAMP'),
        col.str('OWNER', 128),
        col.str('OBJ_NAME', 128),
        col.str('ACTION_NAME', 30),
        col.str('NEW_OWNER', 128),
        col.str('NEW_NAME', 128),
        col.str('OBJ_PRIVILEGE', 16),
        col.str('SES_ACTIONS', 19),
        col.date('LOGOFF_TIME'),
        col.num('LOGOFF_LREAD'),
        col.num('LOGOFF_PREAD'),
        col.num('LOGOFF_LWRITE'),
        col.num('LOGOFF_DLOCK'),
        col.str('COMMENT_TEXT', 4000),
        col.num('SESSIONID'),
        col.num('ENTRYID'),
        col.num('RETURNCODE'),
        col.str('PRIV_USED', 40),
        col.str('CLIENT_ID', 64),
        col.num('SCN'),
        col.str('SQL_TEXT', 2000),
      ],
      rows,
    );
  },
});

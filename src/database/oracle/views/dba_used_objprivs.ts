/**
 * DBA_USED_OBJPRIVS — object privileges used during a privilege capture
 * (native to Oracle 12c+).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const OBJ_PRIVS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'REFERENCES', 'INDEX', 'ALTER', 'READ', 'WRITE']);

registerView({
  name: 'DBA_USED_OBJPRIVS',
  comment: 'Object privileges used during privilege capture',
  query({ instance }) {
    const usage = instance.getAuditJournal().getPrivilegeUsage()
      .filter(r => OBJ_PRIVS.has(r.privilege) && r.objectName);
    return queryResult(
      [
        col.str('CAPTURE', 128),
        col.num('SEQUENCE'),
        col.str('USERNAME', 128),
        col.str('OBJ_PRIV', 128),
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 23),
        col.str('USED_ROLE', 128),
        col.str('PATH', 4000),
        col.date('LAST_USED'),
      ],
      usage.map((r, idx) => [
        'ORA_$DEPENDENCY', idx + 1, r.username, r.privilege,
        r.objectSchema, r.objectName, 'TABLE',
        null, r.privilege, r.lastUsedAt.toISOString(),
      ]),
    );
  },
});

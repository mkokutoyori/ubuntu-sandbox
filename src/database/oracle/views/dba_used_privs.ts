/**
 * DBA_USED_PRIVS — privileges actually used by a user during a
 * `DBMS_PRIVILEGE_CAPTURE` capture run (native to Oracle 12c+).
 *
 * Fed live by the SecurityAuditActor, which records every privilege
 * exercised on the bus. The simulator surfaces the records under the
 * synthetic capture name `ORA_$DEPENDENCY` (the same constant Oracle
 * uses for the implicit always-on capture).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_USED_PRIVS',
  comment: 'Privileges used during privilege capture',
  query({ instance }) {
    const usage = instance.getAuditJournal().getPrivilegeUsage();
    return queryResult(
      [
        col.str('CAPTURE', 128),
        col.num('SEQUENCE'),
        col.str('OS_USER', 128),
        col.str('USERHOST', 128),
        col.str('MODULE', 64),
        col.str('USERNAME', 128),
        col.str('USED_ROLE', 128),
        col.str('PATH', 4000),
        col.str('OBJ_PRIV', 128),
        col.str('SYS_PRIV', 128),
        col.str('USER_PRIV', 128),
        col.str('OBJECT_OWNER', 128),
        col.str('OBJECT_NAME', 128),
        col.str('OBJECT_TYPE', 23),
        col.str('OPTION$', 4000),
        col.str('GRANTEE', 128),
        col.str('GRANTOR', 128),
        col.str('GRANTOR_TYPE', 12),
        col.date('LAST_USED'),
      ],
      usage.map((r, idx) => {
        const sysOrObj = r.objectSchema && r.objectName;
        return [
          'ORA_$DEPENDENCY', idx + 1, 'oracle', 'localhost', null,
          r.username, null, r.privilege,
          sysOrObj ? r.privilege : null,
          sysOrObj ? null : r.privilege,
          null,
          r.objectSchema, r.objectName, sysOrObj ? 'TABLE' : null,
          null, r.username, 'SYS', 'USER',
          r.lastUsedAt.toISOString(),
        ];
      }),
    );
  },
});

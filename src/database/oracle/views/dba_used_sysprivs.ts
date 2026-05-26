/**
 * DBA_USED_SYSPRIVS — system privileges used during a privilege capture
 * (native to Oracle 12c+).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';
import { ORACLE_SYSTEM_PRIVILEGES } from '../security/systemPrivileges';

registerView({
  name: 'DBA_USED_SYSPRIVS',
  comment: 'System privileges used during privilege capture',
  query({ instance }) {
    const usage = instance.getAuditJournal().getPrivilegeUsage()
      .filter(r => ORACLE_SYSTEM_PRIVILEGES.has(r.privilege));
    return queryResult(
      [
        col.str('CAPTURE', 128),
        col.num('SEQUENCE'),
        col.str('USERNAME', 128),
        col.str('SYS_PRIV', 128),
        col.str('USED_ROLE', 128),
        col.str('PATH', 4000),
        col.date('LAST_USED'),
      ],
      usage.map((r, idx) => [
        'ORA_$DEPENDENCY', idx + 1, r.username, r.privilege, null, r.privilege,
        r.lastUsedAt.toISOString(),
      ]),
    );
  },
});

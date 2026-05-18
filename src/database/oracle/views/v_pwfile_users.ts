/**
 * V$PWFILE_USERS — accounts in the external password file with admin
 * privileges. Derived from real DBA_SYS_PRIVS grants so any user the
 * DBA grants SYSDBA/SYSOPER/SYSBACKUP/etc. to immediately shows up;
 * no hardcoded SYS row.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const ADMIN_PRIVS = ['SYSDBA', 'SYSOPER', 'SYSASM', 'SYSBACKUP', 'SYSDG', 'SYSKM'] as const;
type AdminPriv = typeof ADMIN_PRIVS[number];

registerView({
  name: 'V$PWFILE_USERS',
  comment: 'Password-file admin accounts',
  query({ catalog }) {
    const byUser = new Map<string, Record<AdminPriv, boolean>>();
    for (const p of catalog.getSysPrivilegeGrants()) {
      const priv = p.privilege.toUpperCase();
      if (!ADMIN_PRIVS.includes(priv as AdminPriv)) continue;
      const flags = byUser.get(p.grantee)
        ?? { SYSDBA: false, SYSOPER: false, SYSASM: false, SYSBACKUP: false, SYSDG: false, SYSKM: false };
      flags[priv as AdminPriv] = true;
      byUser.set(p.grantee, flags);
    }
    const rows = Array.from(byUser.entries()).map(([user, f]) => [
      user,
      f.SYSDBA ? 'TRUE' : 'FALSE',
      f.SYSOPER ? 'TRUE' : 'FALSE',
      f.SYSASM ? 'TRUE' : 'FALSE',
      f.SYSBACKUP ? 'TRUE' : 'FALSE',
      f.SYSDG ? 'TRUE' : 'FALSE',
      f.SYSKM ? 'TRUE' : 'FALSE',
      0,
    ]);
    return queryResult(
      [
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'SYSDBA', dataType: oracleVarchar2(5) },
        { name: 'SYSOPER', dataType: oracleVarchar2(5) },
        { name: 'SYSASM', dataType: oracleVarchar2(5) },
        { name: 'SYSBACKUP', dataType: oracleVarchar2(5) },
        { name: 'SYSDG', dataType: oracleVarchar2(5) },
        { name: 'SYSKM', dataType: oracleVarchar2(5) },
        { name: 'CON_ID', dataType: oracleNumber(10) },
      ],
      rows
    );
  },
});

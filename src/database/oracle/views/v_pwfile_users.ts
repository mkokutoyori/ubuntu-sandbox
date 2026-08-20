/**
 * V$PWFILE_USERS — accounts in the external password file with admin
 * privileges. Reads the dedicated password-file roster on the catalog
 * (the same store the engine authenticates a remote `AS SYSDBA` against);
 * any user the DBA grants SYSDBA/SYSOPER/SYSBACKUP/etc. shows up, and SYS
 * is always present. Administrative privileges deliberately do NOT appear
 * in DBA_SYS_PRIVS — exactly as on a real instance.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

const ADMIN_PRIVS = ['SYSDBA', 'SYSOPER', 'SYSASM', 'SYSBACKUP', 'SYSDG', 'SYSKM'] as const;

registerView({
  name: 'V$PWFILE_USERS',
  comment: 'Password-file admin accounts',
  query({ catalog }) {
    const rows = catalog.getPasswordFileMembers().map(({ username, privileges }) => [
      username,
      ...ADMIN_PRIVS.map(p => (privileges.has(p) ? 'TRUE' : 'FALSE')),
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

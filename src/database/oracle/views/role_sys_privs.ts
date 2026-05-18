/**
 * ROLE_SYS_PRIVS — system privileges granted to roles.
 *
 * Real projection of the catalog grant registry: every system
 * privilege grant whose grantee is a role (not a user).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'ROLE_SYS_PRIVS',
  comment: 'System privileges granted to roles',
  query({ catalog }) {
    const roleNames = new Set(catalog.getAllRoles().map(r => r.name.toUpperCase()));
    const rows = catalog.getSysPrivilegeGrants()
      .filter(p => roleNames.has(p.grantee.toUpperCase()))
      .map(p => [p.grantee, p.privilege, p.grantable ? 'YES' : 'NO', 'NO', 'NO']);
    return queryResult(
      [
        { name: 'ROLE', dataType: oracleVarchar2(128) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
        { name: 'COMMON', dataType: oracleVarchar2(3) },
        { name: 'INHERITED', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  },
});

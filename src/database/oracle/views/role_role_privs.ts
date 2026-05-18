/**
 * ROLE_ROLE_PRIVS — roles granted to other roles.
 *
 * Real projection of the catalog role-grant registry: every role grant
 * whose grantee is itself a role.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'ROLE_ROLE_PRIVS',
  comment: 'Roles granted to roles',
  query({ catalog }) {
    const roleNames = new Set(catalog.getAllRoles().map(r => r.name.toUpperCase()));
    const rows = catalog.getRoleGrants()
      .filter(rg => roleNames.has(rg.grantee.toUpperCase()))
      .map(rg => [rg.grantee, rg.role, rg.adminOption ? 'YES' : 'NO', 'NO', 'NO']);
    return queryResult(
      [
        { name: 'ROLE', dataType: oracleVarchar2(128) },
        { name: 'GRANTED_ROLE', dataType: oracleVarchar2(128) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
        { name: 'COMMON', dataType: oracleVarchar2(3) },
        { name: 'INHERITED', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  },
});

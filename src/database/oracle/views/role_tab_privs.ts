/**
 * ROLE_TAB_PRIVS — object privileges granted to roles.
 *
 * Real projection of the catalog grant registry: every object
 * privilege grant whose grantee is a role (not a user).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'ROLE_TAB_PRIVS',
  comment: 'Table privileges granted to roles',
  query({ catalog }) {
    const roleNames = new Set(catalog.getAllRoles().map(r => r.name.toUpperCase()));
    const rows = catalog.getTablePrivilegeGrants()
      .filter(p => roleNames.has(p.grantee.toUpperCase()))
      .map(p => [
        p.grantee,
        p.objectSchema ?? 'SYS',
        p.objectName ?? '',
        null,                       // COLUMN_NAME — object-level grant
        p.privilege,
        p.grantable ? 'YES' : 'NO',
        'NO',                       // COMMON
        'NO',                       // INHERITED
      ]);
    return queryResult(
      [
        { name: 'ROLE', dataType: oracleVarchar2(128) },
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(128) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(128) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'GRANTABLE', dataType: oracleVarchar2(3) },
        { name: 'COMMON', dataType: oracleVarchar2(3) },
        { name: 'INHERITED', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  },
});

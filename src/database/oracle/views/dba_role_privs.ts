/**
 * DBA_ROLE_PRIVS — role grants, from the catalog grant registry.
 * Adds the 19c DELEGATE_OPTION / DEFAULT_ROLE / COMMON / INHERITED
 * columns so the standard DBA queries parse without ORA-00904.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_ROLE_PRIVS',
  comment: 'Role privileges',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(128) },
        { name: 'GRANTED_ROLE', dataType: oracleVarchar2(128) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
        { name: 'DELEGATE_OPTION', dataType: oracleVarchar2(3) },
        { name: 'DEFAULT_ROLE', dataType: oracleVarchar2(3) },
        { name: 'OS_GRANTED', dataType: oracleVarchar2(3) },
        { name: 'COMMON', dataType: oracleVarchar2(3) },
        { name: 'INHERITED', dataType: oracleVarchar2(3) },
      ],
      catalog.getRoleGrants().map(rg => [
        rg.grantee, rg.role,
        rg.adminOption ? 'YES' : 'NO',
        'NO',
        'YES',                 // DEFAULT_ROLE — all grants default-on until SET ROLE changes it
        'NO',
        'NO',
        'NO',
      ]),
    );
  },
});

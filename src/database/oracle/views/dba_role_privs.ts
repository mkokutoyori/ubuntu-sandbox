/**
 * DBA_ROLE_PRIVS — role grants, from the catalog grant registry.
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
        { name: 'GRANTEE', dataType: oracleVarchar2(30) },
        { name: 'GRANTED_ROLE', dataType: oracleVarchar2(30) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
      ],
      catalog.getRoleGrants().map(rg => [rg.grantee, rg.role, rg.adminOption ? 'YES' : 'NO'])
    );
  },
});

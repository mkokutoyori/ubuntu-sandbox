/**
 * DBA_SYS_PRIVS — system privilege grants, from the catalog registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SYS_PRIVS',
  comment: 'System privileges',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(30) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
      ],
      catalog.getSysPrivilegeGrants().map(p => [p.grantee, p.privilege, p.grantable ? 'YES' : 'NO'])
    );
  },
});

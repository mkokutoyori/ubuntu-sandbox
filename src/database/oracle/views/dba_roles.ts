/**
 * DBA_ROLES — database roles, from the catalog role registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_ROLES',
  comment: 'Database roles',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'ROLE', dataType: oracleVarchar2(30) },
        { name: 'PASSWORD_REQUIRED', dataType: oracleVarchar2(8) },
      ],
      catalog.getAllRoles().map(r => [r.name, r.passwordRequired ? 'YES' : 'NO'])
    );
  },
});

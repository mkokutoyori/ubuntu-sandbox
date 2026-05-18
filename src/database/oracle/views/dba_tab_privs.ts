/**
 * DBA_TAB_PRIVS — object privilege grants, from the catalog registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_PRIVS',
  comment: 'Object privileges',
  query({ catalog }) {
    const rows: (string | number | null)[][] = catalog.getTablePrivilegeGrants().map(p => [
      p.grantee,
      p.objectSchema ?? 'SYS',
      p.objectName ?? '',
      p.privilege,
      p.grantable ? 'YES' : 'NO',
      'SYS',
      'OBJECT',
    ]);
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(128) },
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(128) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'GRANTABLE', dataType: oracleVarchar2(3) },
        { name: 'GRANTOR', dataType: oracleVarchar2(128) },
        { name: 'TYPE', dataType: oracleVarchar2(24) },
      ],
      rows
    );
  },
});

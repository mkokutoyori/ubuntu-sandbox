/**
 * DBA_LOG_GROUPS — supplemental log groups defined via
 * `ALTER TABLE … ADD SUPPLEMENTAL LOG GROUP`. Rows derive from the
 * real catalog map so DDL ↔ dictionary stay consistent.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_LOG_GROUPS',
  comment: 'Supplemental log groups',
  query({ catalog }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'LOG_GROUP_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'LOG_GROUP_TYPE', dataType: oracleVarchar2(19) },
        { name: 'ALWAYS', dataType: oracleVarchar2(11) },
        { name: 'GENERATED', dataType: oracleVarchar2(14) },
      ],
      catalog.getSupplementalLogGroups().map(g => [
        g.owner, g.logGroupName, g.tableName,
        'USER LOG GROUP',
        g.always ? 'ALWAYS' : 'CONDITIONAL',
        'USER NAME',
      ]),
    );
  },
});

/**
 * DBA_LOG_GROUP_COLUMNS — per-column membership for supplemental log
 * groups. Empty until the catalog tracks them.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_LOG_GROUP_COLUMNS',
  comment: 'Columns of supplemental log groups',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'LOG_GROUP_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'POSITION', dataType: oracleNumber(10) },
        { name: 'LOGGING_PROPERTY', dataType: oracleVarchar2(6) },
      ],
      []
    );
  },
});

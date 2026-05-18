/**
 * V$SQL_PLAN — execution plans. Empty until a plan cache is simulated.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_PLAN',
  comment: 'SQL execution plans',
  query() {
    return queryResult(
      [
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'PLAN_HASH_VALUE', dataType: oracleNumber(20) },
        { name: 'CHILD_NUMBER', dataType: oracleNumber(10) },
        { name: 'OPERATION', dataType: oracleVarchar2(30) },
        { name: 'OPTIONS', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'COST', dataType: oracleNumber(20) },
        { name: 'CARDINALITY', dataType: oracleNumber(20) },
        { name: 'BYTES', dataType: oracleNumber(20) },
      ],
      []
    );
  },
});

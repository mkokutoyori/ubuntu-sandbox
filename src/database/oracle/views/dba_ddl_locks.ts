/**
 * DBA_DDL_LOCKS — DDL locks currently held. Empty in steady state.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_DDL_LOCKS',
  comment: 'DDL locks',
  query() {
    return queryResult(
      [
        { name: 'SESSION_ID', dataType: oracleNumber(10) },
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'TYPE', dataType: oracleVarchar2(40) },
        { name: 'MODE_HELD', dataType: oracleVarchar2(9) },
        { name: 'MODE_REQUESTED', dataType: oracleVarchar2(9) },
      ],
      []
    );
  },
});

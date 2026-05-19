/**
 * DBA_DML_LOCKS — DML locks currently held. Derived from runtime
 * lock state; empty when no DML is in flight.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_DML_LOCKS',
  comment: 'DML locks',
  query() {
    return queryResult(
      [
        { name: 'SESSION_ID', dataType: oracleNumber(10) },
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'MODE_HELD', dataType: oracleVarchar2(13) },
        { name: 'MODE_REQUESTED', dataType: oracleVarchar2(13) },
        { name: 'LAST_CONVERT', dataType: oracleNumber(10) },
        { name: 'BLOCKING_OTHERS', dataType: oracleVarchar2(40) },
      ],
      []
    );
  },
});

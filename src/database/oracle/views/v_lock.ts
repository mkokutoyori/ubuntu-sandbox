/**
 * V$LOCK — active locks. No lock manager is simulated, so empty.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOCK',
  comment: 'Active locks',
  query() {
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'TYPE', dataType: oracleVarchar2(2) },
        { name: 'ID1', dataType: oracleNumber(20) },
        { name: 'ID2', dataType: oracleNumber(20) },
        { name: 'LMODE', dataType: oracleNumber(10) },
        { name: 'REQUEST', dataType: oracleNumber(10) },
        { name: 'BLOCK', dataType: oracleNumber(10) },
      ],
      []
    );
  },
});

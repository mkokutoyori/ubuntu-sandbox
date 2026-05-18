/**
 * V$TRANSACTION — active transactions. None tracked in the simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$TRANSACTION',
  comment: 'Active transactions',
  query() {
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'XIDUSN', dataType: oracleNumber(10) },
        { name: 'XIDSLOT', dataType: oracleNumber(10) },
        { name: 'XIDSQN', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
        { name: 'START_TIME', dataType: oracleVarchar2(20) },
        { name: 'USED_UBLK', dataType: oracleNumber(10) },
        { name: 'USED_UREC', dataType: oracleNumber(10) },
      ],
      []
    );
  },
});

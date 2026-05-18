/**
 * V$LOCKED_OBJECT — locked objects. None in the simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$LOCKED_OBJECT',
  comment: 'Locked objects',
  query() {
    return queryResult(
      [
        { name: 'XIDUSN', dataType: oracleNumber(10) },
        { name: 'XIDSLOT', dataType: oracleNumber(10) },
        { name: 'XIDSQN', dataType: oracleNumber(10) },
        { name: 'OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'SESSION_ID', dataType: oracleNumber(10) },
        { name: 'ORACLE_USERNAME', dataType: oracleVarchar2(30) },
        { name: 'LOCKED_MODE', dataType: oracleNumber(10) },
      ],
      []
    );
  },
});

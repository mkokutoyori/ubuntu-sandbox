/**
 * V$NONLOGGED_BLOCK — blocks flagged as nonlogged (e.g. by NOLOGGING
 * direct-path loads). Empty in a healthy simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$NONLOGGED_BLOCK',
  comment: 'Nonlogged blocks reported by datafiles',
  query() {
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'BLOCK#', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'NONLOGGED_START_CHANGE#', dataType: oracleNumber(20) },
        { name: 'NONLOGGED_END_CHANGE#', dataType: oracleNumber(20) },
        { name: 'RESETLOGS_CHANGE#', dataType: oracleNumber(20) },
        { name: 'OBJECT#', dataType: oracleNumber(20) },
        { name: 'REASON', dataType: oracleVarchar2(64) },
      ],
      []
    );
  },
});

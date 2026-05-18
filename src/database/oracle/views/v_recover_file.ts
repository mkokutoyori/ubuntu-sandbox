/**
 * V$RECOVER_FILE — files needing media recovery. None in the simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$RECOVER_FILE',
  comment: 'Files needing recovery',
  query() {
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'ONLINE_STATUS', dataType: oracleVarchar2(7) },
        { name: 'ERROR', dataType: oracleVarchar2(18) },
        { name: 'CHANGE#', dataType: oracleNumber(20) },
        { name: 'TIME', dataType: oracleDate() },
      ],
      []
    );
  },
});

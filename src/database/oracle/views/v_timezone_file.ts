/**
 * V$TIMEZONE_FILE — current time zone file in use. The simulator
 * ships a single 32-version DST file (matches Oracle 19c default).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$TIMEZONE_FILE',
  comment: 'Time zone file in use',
  query() {
    return queryResult(
      [
        { name: 'FILENAME', dataType: oracleVarchar2(64) },
        { name: 'VERSION', dataType: oracleNumber(10) },
        { name: 'CON_ID', dataType: oracleNumber(10) },
      ],
      [['timezlrg_32.dat', 32, 0]]
    );
  },
});

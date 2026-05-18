/**
 * V$ASM_CLIENT — DB instances connected to ASM.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';
registerView({
  name: 'V$ASM_CLIENT',
  comment: 'ASM clients',
  query() {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'INSTANCE_NAME', dataType: oracleVarchar2(64) },
        { name: 'DB_NAME', dataType: oracleVarchar2(8) },
        { name: 'STATUS', dataType: oracleVarchar2(12) },
        { name: 'SOFTWARE_VERSION', dataType: oracleVarchar2(60) },
        { name: 'COMPATIBLE_VERSION', dataType: oracleVarchar2(60) },
      ],
      []
    );
  },
});

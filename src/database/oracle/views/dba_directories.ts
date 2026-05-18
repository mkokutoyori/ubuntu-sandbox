/**
 * DBA_DIRECTORIES — directory objects (default DATA_PUMP_DIR).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_DIRECTORIES',
  comment: 'Directory objects',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'DIRECTORY_NAME', dataType: oracleVarchar2(30) },
        { name: 'DIRECTORY_PATH', dataType: oracleVarchar2(4000) },
      ],
      [
        ['SYS', 'DATA_PUMP_DIR', '/u01/app/oracle/admin/ORCL/dpdump/'],
      ]
    );
  },
});

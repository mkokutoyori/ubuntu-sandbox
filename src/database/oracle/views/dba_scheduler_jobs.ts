/**
 * DBA_SCHEDULER_JOBS — DBMS_SCHEDULER jobs. None in the simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_JOBS',
  comment: 'DBMS_SCHEDULER jobs',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'JOB_NAME', dataType: oracleVarchar2(30) },
        { name: 'JOB_TYPE', dataType: oracleVarchar2(16) },
        { name: 'STATE', dataType: oracleVarchar2(15) },
        { name: 'ENABLED', dataType: oracleVarchar2(5) },
        { name: 'NEXT_RUN_DATE', dataType: oracleDate() },
      ],
      []
    );
  },
});

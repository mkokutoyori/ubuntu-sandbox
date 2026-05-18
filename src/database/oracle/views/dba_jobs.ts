/**
 * DBA_JOBS — legacy DBMS_JOB jobs. None in the simulator.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_JOBS',
  comment: 'DBMS_JOB scheduled jobs',
  query() {
    return queryResult(
      [
        { name: 'JOB', dataType: oracleNumber(10) },
        { name: 'LOG_USER', dataType: oracleVarchar2(30) },
        { name: 'SCHEMA_USER', dataType: oracleVarchar2(30) },
        { name: 'WHAT', dataType: oracleVarchar2(4000) },
        { name: 'NEXT_DATE', dataType: oracleDate() },
        { name: 'BROKEN', dataType: oracleVarchar2(1) },
      ],
      []
    );
  },
});

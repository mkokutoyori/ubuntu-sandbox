/**
 * V$DIAG_INCIDENT — ADR incidents. Healthy sim → empty.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$DIAG_INCIDENT',
  comment: 'ADR incidents',
  query() {
    return queryResult(
      [
        { name: 'INCIDENT_ID', dataType: oracleNumber(20) },
        { name: 'PROBLEM_ID', dataType: oracleNumber(20) },
        { name: 'CREATE_TIME', dataType: oracleDate() },
        { name: 'CLOSE_TIME', dataType: oracleDate() },
        { name: 'STATUS', dataType: oracleVarchar2(20) },
        { name: 'FLAGS', dataType: oracleNumber(10) },
        { name: 'FLOOD_CONTROLLED', dataType: oracleVarchar2(20) },
        { name: 'ERROR_FACILITY', dataType: oracleVarchar2(10) },
        { name: 'ERROR_NUMBER', dataType: oracleNumber(10) },
        { name: 'ERROR_ARG1', dataType: oracleVarchar2(64) },
      ],
      []
    );
  },
});

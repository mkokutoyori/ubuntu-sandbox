/**
 * V$DIAG_PROBLEM — ADR problems (critical errors). Healthy sim → empty.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$DIAG_PROBLEM',
  comment: 'ADR problems',
  query() {
    return queryResult(
      [
        { name: 'PROBLEM_ID', dataType: oracleNumber(20) },
        { name: 'PROBLEM_KEY', dataType: oracleVarchar2(550) },
        { name: 'FIRST_INCIDENT', dataType: oracleNumber(20) },
        { name: 'FIRSTINC_TIME', dataType: oracleDate() },
        { name: 'LAST_INCIDENT', dataType: oracleNumber(20) },
        { name: 'LASTINC_TIME', dataType: oracleDate() },
        { name: 'IMPACT', dataType: oracleNumber(20) },
        { name: 'SERVICE_REQUEST', dataType: oracleVarchar2(64) },
        { name: 'BUG_NUMBER', dataType: oracleVarchar2(64) },
      ],
      []
    );
  },
});

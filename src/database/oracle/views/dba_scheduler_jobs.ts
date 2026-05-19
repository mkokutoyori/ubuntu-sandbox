/**
 * DBA_SCHEDULER_JOBS — DBMS_SCHEDULER jobs. Empty until the simulator
 * implements job management, but the full 19c column set is exposed
 * so DBA scripts that probe RUN_COUNT / FAILURE_COUNT / etc. parse.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_JOBS',
  comment: 'DBMS_SCHEDULER jobs',
  query() {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'JOB_NAME', dataType: oracleVarchar2(30) },
        { name: 'JOB_SUBNAME', dataType: oracleVarchar2(30) },
        { name: 'JOB_STYLE', dataType: oracleVarchar2(16) },
        { name: 'JOB_CREATOR', dataType: oracleVarchar2(30) },
        { name: 'CLIENT_ID', dataType: oracleVarchar2(64) },
        { name: 'GLOBAL_UID', dataType: oracleVarchar2(32) },
        { name: 'PROGRAM_OWNER', dataType: oracleVarchar2(30) },
        { name: 'PROGRAM_NAME', dataType: oracleVarchar2(30) },
        { name: 'JOB_TYPE', dataType: oracleVarchar2(16) },
        { name: 'JOB_ACTION', dataType: oracleVarchar2(4000) },
        { name: 'NUMBER_OF_ARGUMENTS', dataType: oracleNumber(10) },
        { name: 'SCHEDULE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'SCHEDULE_NAME', dataType: oracleVarchar2(30) },
        { name: 'SCHEDULE_TYPE', dataType: oracleVarchar2(12) },
        { name: 'START_DATE', dataType: oracleDate() },
        { name: 'REPEAT_INTERVAL', dataType: oracleVarchar2(4000) },
        { name: 'END_DATE', dataType: oracleDate() },
        { name: 'JOB_CLASS', dataType: oracleVarchar2(30) },
        { name: 'ENABLED', dataType: oracleVarchar2(5) },
        { name: 'AUTO_DROP', dataType: oracleVarchar2(5) },
        { name: 'RESTART_ON_RECOVERY', dataType: oracleVarchar2(5) },
        { name: 'RESTART_ON_FAILURE', dataType: oracleVarchar2(5) },
        { name: 'STATE', dataType: oracleVarchar2(15) },
        { name: 'JOB_PRIORITY', dataType: oracleNumber(10) },
        { name: 'RUN_COUNT', dataType: oracleNumber(20) },
        { name: 'MAX_RUNS', dataType: oracleNumber(20) },
        { name: 'FAILURE_COUNT', dataType: oracleNumber(20) },
        { name: 'MAX_FAILURES', dataType: oracleNumber(20) },
        { name: 'RETRY_COUNT', dataType: oracleNumber(20) },
        { name: 'LAST_START_DATE', dataType: oracleDate() },
        { name: 'LAST_RUN_DURATION', dataType: oracleVarchar2(64) },
        { name: 'NEXT_RUN_DATE', dataType: oracleDate() },
        { name: 'COMMENTS', dataType: oracleVarchar2(240) },
      ],
      []
    );
  },
});

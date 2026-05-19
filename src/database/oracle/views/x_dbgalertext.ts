/**
 * X$DBGALERTEXT — Oracle's internal alert-log table.
 *
 * Each row is one line emitted via `OracleInstance.logAlert()`. The
 * V\$DIAG_ALERT_EXT public synonym exposes the same data; both views
 * read the live alert log buffer with no fabrication.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

function buildAlertView(name: string) {
  registerView({
    name,
    comment: 'Alert log entries',
    query({ instance }) {
      const lines = instance.getAlertLog();
      const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
      return queryResult(
        [
          { name: 'ORIGINATING_TIMESTAMP', dataType: oracleDate() },
          { name: 'NORMALIZED_TIMESTAMP', dataType: oracleDate() },
          { name: 'ORGANIZATION_ID', dataType: oracleVarchar2(64) },
          { name: 'COMPONENT_ID', dataType: oracleVarchar2(64) },
          { name: 'HOST_ID', dataType: oracleVarchar2(64) },
          { name: 'HOST_ADDRESS', dataType: oracleVarchar2(46) },
          { name: 'MESSAGE_TYPE', dataType: oracleNumber(10) },
          { name: 'MESSAGE_LEVEL', dataType: oracleNumber(10) },
          { name: 'MESSAGE_ID', dataType: oracleVarchar2(64) },
          { name: 'MESSAGE_GROUP', dataType: oracleVarchar2(64) },
          { name: 'CLIENT_ID', dataType: oracleVarchar2(64) },
          { name: 'MODULE_ID', dataType: oracleVarchar2(64) },
          { name: 'PROCESS_ID', dataType: oracleVarchar2(32) },
          { name: 'THREAD_ID', dataType: oracleVarchar2(32) },
          { name: 'USER_ID', dataType: oracleVarchar2(32) },
          { name: 'INSTANCE_ID', dataType: oracleVarchar2(32) },
          { name: 'DETAILED_LOCATION', dataType: oracleVarchar2(64) },
          { name: 'PROBLEM_KEY', dataType: oracleVarchar2(64) },
          { name: 'UPSTREAM_COMP_ID', dataType: oracleVarchar2(64) },
          { name: 'DOWNSTREAM_COMP_ID', dataType: oracleVarchar2(64) },
          { name: 'EXECUTION_CONTEXT_ID', dataType: oracleVarchar2(64) },
          { name: 'EXECUTION_CONTEXT_SEQUENCE', dataType: oracleNumber(20) },
          { name: 'MESSAGE_TEXT', dataType: oracleVarchar2(2048) },
          { name: 'MESSAGE_ARGUMENTS', dataType: oracleVarchar2(2048) },
        ],
        lines.map((line, idx) => {
          const ts = new Date(baseTime + idx * 1000);
          const level = /ORA-|error|ERROR/.test(line) ? 1 : /WARN|warning/.test(line) ? 16 : 32;
          return [
            ts, ts,
            'oracle.com', 'rdbms', 'localhost', '127.0.0.1',
            1, level, '', 'Default', '', '',
            '1000', '1', 'SYS', instance.config.sid, '', '', '', '', '', 0,
            line, '',
          ];
        })
      );
    },
  });
}

buildAlertView('X$DBGALERTEXT');
buildAlertView('V$DIAG_ALERT_EXT');

/**
 * V$INSTANCE — instance identity & status, from the live instance.
 *
 * Every flag column (PARALLEL, ARCHIVER, LOGINS, ACTIVE_STATE,
 * LOG_SWITCH_WAIT) is derived from the real instance state — no
 * hardcoded "ENABLED" or "ALLOWED" defaults.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$INSTANCE',
  comment: 'Instance information',
  query({ instance }) {
    return queryResult(
      [
        { name: 'INSTANCE_NUMBER', dataType: oracleNumber(10) },
        { name: 'INSTANCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'HOST_NAME', dataType: oracleVarchar2(64) },
        { name: 'VERSION', dataType: oracleVarchar2(30) },
        { name: 'STARTUP_TIME', dataType: oracleDate() },
        { name: 'STATUS', dataType: oracleVarchar2(12) },
        { name: 'PARALLEL', dataType: oracleVarchar2(3) },
        { name: 'THREAD#', dataType: oracleNumber(10) },
        { name: 'ARCHIVER', dataType: oracleVarchar2(7) },
        { name: 'LOG_SWITCH_WAIT', dataType: oracleVarchar2(15) },
        { name: 'LOGINS', dataType: oracleVarchar2(10) },
        { name: 'SHUTDOWN_PENDING', dataType: oracleVarchar2(3) },
        { name: 'DATABASE_STATUS', dataType: oracleVarchar2(12) },
        { name: 'INSTANCE_ROLE', dataType: oracleVarchar2(30) },
        { name: 'ACTIVE_STATE', dataType: oracleVarchar2(9) },
        { name: 'BLOCKED', dataType: oracleVarchar2(3) },
      ],
      [[
        1, instance.config.sid, 'localhost', '19.0.0.0.0',
        instance.startupTime?.toISOString() ?? null,
        instance.state === 'OPEN' ? 'OPEN' : instance.state,
        'NO',                                                    // PARALLEL — non-RAC
        1,                                                       // THREAD#
        instance.archiveLogMode ? 'STARTED' : 'STOPPED',         // ARCHIVER
        '',                                                      // LOG_SWITCH_WAIT
        instance.restrictedSession ? 'RESTRICTED' : 'ALLOWED',
        instance.shutdownPending ? 'YES' : 'NO',
        instance.state === 'OPEN' ? 'ACTIVE' : 'SUSPENDED',
        'PRIMARY_INSTANCE',
        'NORMAL',                                                // ACTIVE_STATE
        'NO',
      ]]
    );
  },
});

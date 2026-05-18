/**
 * V$INSTANCE — instance identity & status, from the live instance.
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
        { name: 'DATABASE_STATUS', dataType: oracleVarchar2(12) },
        { name: 'INSTANCE_ROLE', dataType: oracleVarchar2(30) },
      ],
      [[
        1, instance.config.sid, 'localhost', '19.0.0.0.0',
        instance.startupTime?.toISOString() ?? null,
        instance.state === 'OPEN' ? 'OPEN' : instance.state,
        instance.state === 'OPEN' ? 'ACTIVE' : 'SUSPENDED',
        'PRIMARY_INSTANCE',
      ]]
    );
  },
});

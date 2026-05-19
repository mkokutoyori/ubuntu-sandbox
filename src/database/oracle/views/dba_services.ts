/**
 * DBA_SERVICES — database services. Mirrors V\$SERVICES with a
 * dictionary-style column set; rows come from the same instance
 * service registry.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';
import { ORACLE_CONFIG } from '../../../terminal/commands/OracleConfig';

registerView({
  name: 'DBA_SERVICES',
  comment: 'Database services',
  query({ instance }) {
    // The instance always exposes a default service named after the SID.
    const services = [
      ORACLE_CONFIG.SID,
      `${ORACLE_CONFIG.SID}XDB`,
      'SYS$BACKGROUND',
      'SYS$USERS',
    ];
    return queryResult(
      [
        { name: 'SERVICE_ID', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'NAME_HASH', dataType: oracleNumber(20) },
        { name: 'NETWORK_NAME', dataType: oracleVarchar2(64) },
        { name: 'CREATION_DATE', dataType: oracleDate() },
        { name: 'CREATION_DATE_HASH', dataType: oracleNumber(20) },
        { name: 'FAILOVER_METHOD', dataType: oracleVarchar2(64) },
        { name: 'FAILOVER_TYPE', dataType: oracleVarchar2(64) },
        { name: 'FAILOVER_RETRIES', dataType: oracleNumber(10) },
        { name: 'FAILOVER_DELAY', dataType: oracleNumber(10) },
        { name: 'ENABLED', dataType: oracleVarchar2(3) },
      ],
      services.map((name, i) => [
        i + 1, name, i * 100,
        name === 'SYS$BACKGROUND' || name === 'SYS$USERS' ? null : name,
        instance.startupTime ?? new Date(), 0,
        '', '', 0, 0,
        'YES',
      ])
    );
  },
});

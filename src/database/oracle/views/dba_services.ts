/**
 * DBA_SERVICES — database services. Derived from the same
 * `runtime.services` source V\$SERVICES reads, so dictionary and
 * dynamic views agree row-for-row (and stay in lockstep with the
 * underlying systemd state via OracleSystemdSync).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_SERVICES',
  comment: 'Database services',
  query({ runtime }) {
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
      [...runtime.services.values()].map((s, idx) => [
        idx + 1, s.name, idx * 100, s.name,
        new Date(s.startedAt), s.startedAt | 0,
        '', '', 0, 0,
        'YES',
      ])
    );
  },
});

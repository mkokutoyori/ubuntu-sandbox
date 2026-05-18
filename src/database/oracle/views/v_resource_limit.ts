/**
 * V$RESOURCE_LIMIT — instance resource utilisation/limits.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$RESOURCE_LIMIT',
  comment: 'Resource limits',
  query() {
    return queryResult(
      [
        { name: 'RESOURCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'CURRENT_UTILIZATION', dataType: oracleNumber(10) },
        { name: 'MAX_UTILIZATION', dataType: oracleNumber(10) },
        { name: 'INITIAL_ALLOCATION', dataType: oracleVarchar2(10) },
        { name: 'LIMIT_VALUE', dataType: oracleVarchar2(10) },
      ],
      [
        ['processes', 5, 5, '300', '300'],
        ['sessions', 1, 1, '472', '472'],
        ['enqueue_locks', 0, 0, '5588', '5588'],
        ['enqueue_resources', 0, 0, '2516', 'UNLIMITED'],
        ['ges_procs', 0, 0, '0', '0'],
        ['max_shared_servers', 0, 0, 'UNLIMITED', 'UNLIMITED'],
        ['parallel_max_servers', 0, 0, '40', '40'],
      ]
    );
  },
});

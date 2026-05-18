/**
 * V$OPTION — installed database options.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$OPTION',
  comment: 'Database options',
  query() {
    return queryResult(
      [
        { name: 'PARAMETER', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(64) },
      ],
      [
        ['Partitioning', 'TRUE'],
        ['Objects', 'TRUE'],
        ['Real Application Clusters', 'FALSE'],
        ['Advanced replication', 'TRUE'],
        ['Bit-mapped indexes', 'TRUE'],
        ['Connection multiplexing', 'TRUE'],
        ['Connection pooling', 'TRUE'],
        ['Database queuing', 'TRUE'],
        ['Incremental backup and recovery', 'TRUE'],
        ['Instead-of triggers', 'TRUE'],
        ['Parallel backup and recovery', 'TRUE'],
        ['Parallel execution', 'TRUE'],
        ['Parallel load', 'TRUE'],
        ['Plan Stability', 'TRUE'],
        ['Point-in-time tablespace recovery', 'TRUE'],
        ['Server flash cache', 'TRUE'],
        ['Spatial', 'TRUE'],
        ['Transparent Data Encryption', 'TRUE'],
      ]
    );
  },
});

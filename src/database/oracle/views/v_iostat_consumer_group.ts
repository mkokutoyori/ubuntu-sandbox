/**
 * V$IOSTAT_CONSUMER_GROUP — per resource consumer group I/O stats.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$IOSTAT_CONSUMER_GROUP',
  comment: 'Per-consumer-group I/O statistics',
  query() {
    return queryResult(
      [
        { name: 'CONSUMER_GROUP_ID', dataType: oracleNumber(10) },
        { name: 'CONSUMER_GROUP_NAME', dataType: oracleVarchar2(30) },
        { name: 'SMALL_READ_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'SMALL_WRITE_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'LARGE_READ_MEGABYTES', dataType: oracleNumber(20) },
        { name: 'LARGE_WRITE_MEGABYTES', dataType: oracleNumber(20) },
      ],
      []
    );
  },
});

/**
 * V$SQLAREA — shared SQL area aggregate. Empty until a cursor cache
 * is simulated.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SQLAREA',
  comment: 'Shared SQL area',
  query() {
    return queryResult(
      [
        { name: 'SQL_TEXT', dataType: oracleVarchar2(1000) },
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'VERSION_COUNT', dataType: oracleNumber(10) },
        { name: 'EXECUTIONS', dataType: oracleNumber(20) },
        { name: 'SORTS', dataType: oracleNumber(20) },
        { name: 'DISK_READS', dataType: oracleNumber(20) },
        { name: 'BUFFER_GETS', dataType: oracleNumber(20) },
        { name: 'ROWS_PROCESSED', dataType: oracleNumber(20) },
      ],
      []
    );
  },
});

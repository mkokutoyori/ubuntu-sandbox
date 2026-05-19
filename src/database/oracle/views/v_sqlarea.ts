/**
 * V$SQLAREA — shared SQL area aggregate.
 *
 * Same backing store as V$SQL/V$SQLSTATS (`runtime.sqlCache`) so the
 * three views stay coherent. Each parent cursor (uniquely identified by
 * SQL_ID in this simulator) has a single child, hence VERSION_COUNT = 1.
 * SORTS is not separately tracked — a conservative 0 is reported until
 * the sort accounting is modelled.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SQLAREA',
  comment: 'Shared SQL area',
  query({ runtime }) {
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
      [...runtime.sqlCache.values()].map(s => [
        s.text, s.sqlId, 1, s.executions, 0, s.diskReads, s.bufferGets, s.rowsProcessed,
      ])
    );
  },
});

/**
 * V$SQL — SQL statements in the cursor cache.
 *
 * Projection of `runtime.sqlCache` — populated by the `oracle.sql.parsed`
 * event and updated on every `oracle.sql.executed`. Mirrors what
 * V$SQLSTATS surfaces, so the two views stay coherent for any test that
 * cross-joins them.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SQL',
  comment: 'SQL statements in cache',
  query({ runtime }) {
    return queryResult(
      [
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'SQL_TEXT', dataType: oracleVarchar2(1000) },
        { name: 'EXECUTIONS', dataType: oracleNumber(20) },
        { name: 'ELAPSED_TIME', dataType: oracleNumber(20) },
        { name: 'CPU_TIME', dataType: oracleNumber(20) },
        { name: 'BUFFER_GETS', dataType: oracleNumber(20) },
        { name: 'DISK_READS', dataType: oracleNumber(20) },
        { name: 'ROWS_PROCESSED', dataType: oracleNumber(20) },
        { name: 'PARSING_SCHEMA_NAME', dataType: oracleVarchar2(30) },
        { name: 'FIRST_LOAD_TIME', dataType: oracleVarchar2(19) },
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, s.text, s.executions, s.elapsedMicros, s.cpuMicros,
        s.bufferGets, s.diskReads, s.rowsProcessed,
        s.parsingSchema, new Date(s.firstLoadTime).toISOString().slice(0, 19),
      ])
    );
  },
});

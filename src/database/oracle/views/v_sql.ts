/**
 * V$SQL — SQL statements in the cursor cache (representative entry).
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'V$SQL',
  comment: 'SQL statements in cache',
  query() {
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
      [
        ['abc123def45', 'SELECT 1 FROM DUAL', 1, 100, 50, 1, 0, 1, 'SYS', new Date().toISOString().slice(0, 19)],
      ]
    );
  },
});

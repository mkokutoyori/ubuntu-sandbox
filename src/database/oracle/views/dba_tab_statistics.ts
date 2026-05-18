/**
 * DBA_TAB_STATISTICS — table optimizer statistics, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_STATISTICS',
  comment: 'Table statistics',
  query({ storage }) {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'NUM_ROWS', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'AVG_ROW_LEN', dataType: oracleNumber(20) },
        { name: 'LAST_ANALYZED', dataType: oracleDate() },
        { name: 'STALE_STATS', dataType: oracleVarchar2(3) },
      ],
      storage.getAllTables().map(t => [t.schema, t.name, t.rowCount, Math.ceil(t.rowCount * 200 / 8192), 200, new Date().toISOString(), 'NO'])
    );
  },
});

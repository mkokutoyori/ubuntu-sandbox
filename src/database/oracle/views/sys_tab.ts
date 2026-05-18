/**
 * SYS.TAB$ — base table metadata, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SYS.TAB$',
  comment: 'Base table metadata',
  query({ storage }) {
    const tables = storage.getAllTables();
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'COLS', dataType: oracleNumber(10) },
        { name: 'ROWCNT', dataType: oracleNumber(20) },
        { name: 'BLKCNT', dataType: oracleNumber(10) },
      ],
      tables.map((t, i) => [1000 + i, 0, t.columns.length, t.rowCount, Math.ceil(t.rowCount / 100)])
    );
  },
});

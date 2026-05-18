/**
 * SYS.IND$ — base index metadata, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'SYS.IND$',
  comment: 'Base index metadata',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    let i = 0;
    for (const schema of storage.getSchemas()) {
      for (const idx of storage.getIndexes(schema)) {
        rows.push([2000 + i, 1000, idx.unique ? 1 : 0, idx.columns.length, idx.unique ? 'UNIQUE' : 'NONUNIQUE']);
        i++;
      }
    }
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'BO#', dataType: oracleNumber(10) },
        { name: 'TYPE#', dataType: oracleNumber(10) },
        { name: 'COLS', dataType: oracleNumber(10) },
        { name: 'UNIQUENESS', dataType: oracleVarchar2(9) },
      ],
      rows
    );
  },
});

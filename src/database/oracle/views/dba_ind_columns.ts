/**
 * DBA_IND_COLUMNS — index column / expression list, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_IND_COLUMNS',
  comment: 'Index columns',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    for (const schema of storage.getSchemas()) {
      for (const idx of storage.getIndexes(schema)) {
        for (let i = 0; i < idx.columns.length; i++) {
          const expr = idx.expressions?.[i] ?? null;
          rows.push([schema, idx.name, schema, idx.tableName, idx.columns[i], i + 1, idx.columns[i].length, idx.columns[i].length, 'ASC', expr]);
        }
      }
    }
    return queryResult(
      [
        { name: 'INDEX_OWNER', dataType: oracleVarchar2(30) },
        { name: 'INDEX_NAME', dataType: oracleVarchar2(30) },
        // TABLE_OWNER + TABLE_NAME are both 19c columns — separate from
        // INDEX_OWNER because a global temp index can live in a schema
        // distinct from the base table.
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_POSITION', dataType: oracleNumber(10) },
        { name: 'COLUMN_LENGTH', dataType: oracleNumber(10) },
        { name: 'CHAR_LENGTH', dataType: oracleNumber(10) },
        { name: 'DESCEND', dataType: oracleVarchar2(4) },
        { name: 'COLUMN_EXPRESSION', dataType: oracleVarchar2(4000) },
      ],
      rows
    );
  },
});

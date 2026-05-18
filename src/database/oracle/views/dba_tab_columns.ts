/**
 * DBA_TAB_COLUMNS — table column metadata, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_COLUMNS',
  comment: 'Table columns',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        rows.push([t.schema, t.name, c.name, c.dataType.name, c.dataType.precision ?? null, c.dataType.scale ?? null, c.dataType.nullable ? 'Y' : 'N', c.ordinalPosition + 1]);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'DATA_TYPE', dataType: oracleVarchar2(30) },
        { name: 'DATA_LENGTH', dataType: oracleNumber(10) },
        { name: 'DATA_SCALE', dataType: oracleNumber(10) },
        { name: 'NULLABLE', dataType: oracleVarchar2(1) },
        { name: 'COLUMN_ID', dataType: oracleNumber(10) },
      ],
      rows
    );
  },
});

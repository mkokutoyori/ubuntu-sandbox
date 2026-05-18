/**
 * DBA_CONS_COLUMNS — constraint column list, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_CONS_COLUMNS',
  comment: 'Constraint columns',
  query({ storage }) {
    const rows: (string | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.constraints) {
        const cols = c.columns ?? [];
        for (let i = 0; i < cols.length; i++) {
          rows.push([t.schema, c.name, t.name, cols[i], String(i + 1)]);
        }
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'CONSTRAINT_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'POSITION', dataType: oracleNumber(10) },
      ],
      rows
    );
  },
});

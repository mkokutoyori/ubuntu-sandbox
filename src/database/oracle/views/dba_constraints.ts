/**
 * DBA_CONSTRAINTS — table constraints, from real storage.
 */

import { queryResult } from '../../engine/executor/ResultSet';
import { oracleVarchar2 } from '../../engine/catalog/DataType';
import { registerView } from './registry';

registerView({
  name: 'DBA_CONSTRAINTS',
  comment: 'Constraints',
  query({ storage }) {
    const rows: (string | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.constraints) {
        const typeCode = c.type === 'PRIMARY_KEY' ? 'P' : c.type === 'UNIQUE' ? 'U' : c.type === 'FOREIGN_KEY' ? 'R' : c.type === 'CHECK' ? 'C' : 'O';
        rows.push([t.schema, c.name, typeCode, t.name, 'ENABLED']);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'CONSTRAINT_NAME', dataType: oracleVarchar2(30) },
        { name: 'CONSTRAINT_TYPE', dataType: oracleVarchar2(1) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      rows
    );
  },
});

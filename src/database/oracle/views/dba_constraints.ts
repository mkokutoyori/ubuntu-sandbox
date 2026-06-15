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
        // Real Oracle reports NOT NULL constraints as type 'C' with a
        // generated "COL" IS NOT NULL search condition.
        const typeCode = c.type === 'PRIMARY_KEY' ? 'P' : c.type === 'UNIQUE' ? 'U'
          : c.type === 'FOREIGN_KEY' ? 'R'
          : (c.type === 'CHECK' || c.type === 'NOT_NULL') ? 'C' : 'O';
        const searchCondition = c.type === 'CHECK' ? (c.checkExpression ?? null)
          : c.type === 'NOT_NULL' ? `"${c.columns[0]}" IS NOT NULL` : null;
        const deleteRule = c.type === 'FOREIGN_KEY'
          ? (c.onDelete === 'CASCADE' ? 'CASCADE' : c.onDelete === 'SET_NULL' ? 'SET NULL' : 'NO ACTION')
          : null;
        rows.push([t.schema, c.name, typeCode, t.name, searchCondition, deleteRule, 'ENABLED']);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'CONSTRAINT_NAME', dataType: oracleVarchar2(30) },
        { name: 'CONSTRAINT_TYPE', dataType: oracleVarchar2(1) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEARCH_CONDITION', dataType: oracleVarchar2(4000) },
        { name: 'DELETE_RULE', dataType: oracleVarchar2(9) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      rows
    );
  },
});

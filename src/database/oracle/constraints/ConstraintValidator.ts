/**
 * ConstraintValidator — row-level integrity enforcement for DML.
 *
 * Owns the Oracle constraint semantics that previously lived inside the
 * executor: NOT NULL / PRIMARY KEY (ORA-01400), UNIQUE (ORA-00001),
 * FOREIGN KEY parent lookup (ORA-02291), CHECK (ORA-02290), column data
 * types (ORA-12899 / ORA-01438), and DELETE-side referential actions
 * (ON DELETE CASCADE / SET NULL, else ORA-02292).
 *
 * CHECK expressions are parsed once per distinct expression and cached —
 * the executor used to instantiate a fresh lexer + parser for every row
 * of every INSERT/UPDATE.
 */

import type { BaseStorage, StorageRow, TableMeta, ColumnMeta } from '../../engine/storage/BaseStorage';
import type { Expression, SelectStatement } from '../../engine/parser/ASTNode';
import { OracleError } from '../../engine/types/DatabaseError';
import { OracleLexer } from '../OracleLexer';
import { OracleParser } from '../OracleParser';
import { compareValues } from '../functions/valueUtils';

/** Condition evaluator supplied by the executor (full expression machinery). */
export type ConditionEvaluator = (
  condition: Expression,
  row: StorageRow,
  columns: ColumnMeta[],
) => boolean;

/** Parsed CHECK predicates, keyed by their source text. `null` = unparseable. */
const checkExpressionCache = new Map<string, Expression | null>();
const CHECK_CACHE_MAX = 512;

function parseCheckExpression(checkExpression: string): Expression | null {
  if (checkExpressionCache.has(checkExpression)) {
    return checkExpressionCache.get(checkExpression) ?? null;
  }
  let where: Expression | null = null;
  try {
    const tokens = new OracleLexer().tokenize(`SELECT 1 FROM DUAL WHERE ${checkExpression}`);
    const stmt = new OracleParser().parse(tokens) as SelectStatement;
    where = stmt.where ?? null;
  } catch {
    where = null; // unparseable CHECK — skip validation, matching legacy behaviour
  }
  if (checkExpressionCache.size >= CHECK_CACHE_MAX) {
    const oldest = checkExpressionCache.keys().next().value;
    if (oldest !== undefined) checkExpressionCache.delete(oldest);
  }
  checkExpressionCache.set(checkExpression, where);
  return where;
}

export class ConstraintValidator {
  constructor(
    private readonly storage: BaseStorage,
    private readonly evaluateCondition: ConditionEvaluator,
  ) {}

  /**
   * Validate one row against the table's declared constraints.
   * @param excludeRow For UPDATE: the pre-update row excluded from uniqueness checks.
   */
  validateConstraints(
    schema: string,
    tableName: string,
    tableMeta: TableMeta,
    row: StorageRow,
    excludeRow?: StorageRow,
  ): void {
    for (const constraint of tableMeta.constraints) {
      if (constraint.type === 'NOT_NULL' || constraint.type === 'PRIMARY_KEY') {
        for (const colName of constraint.columns) {
          const colIdx = tableMeta.columns.findIndex(c => c.name === colName);
          if (colIdx >= 0 && row[colIdx] === null) {
            throw new OracleError(1400, `cannot insert NULL into ("${schema}"."${tableName}"."${colName}")`);
          }
        }
      }
      if (constraint.type === 'PRIMARY_KEY' || constraint.type === 'UNIQUE') {
        const existingRows = this.storage.getRows(schema, tableName);
        const colIndexes = constraint.columns.map(cn => tableMeta.columns.findIndex(c => c.name === cn));
        const newKey = colIndexes.map(i => row[i]);
        for (const existing of existingRows) {
          if (excludeRow && existing === excludeRow) continue;
          const existingKey = colIndexes.map(i => existing[i]);
          if (newKey.every((v, i) => compareValues(v, existingKey[i]) === 0)) {
            throw new OracleError(1, `unique constraint (${constraint.name}) violated`);
          }
        }
      }
      // FOREIGN KEY: check parent key exists
      if (constraint.type === 'FOREIGN_KEY' && constraint.refTable && constraint.refColumns) {
        const colIndexes = constraint.columns.map(cn => tableMeta.columns.findIndex(c => c.name === cn));
        const fkValues = colIndexes.map(i => row[i]);
        // Skip if any FK column is NULL (NULL FK is allowed)
        if (fkValues.some(v => v === null)) continue;
        const refSchema = schema; // FK references are within the same schema by default
        const refTable = constraint.refTable;
        if (this.storage.tableExists(refSchema, refTable)) {
          const refMeta = this.storage.getTableMeta(refSchema, refTable)!;
          const refColIndexes = constraint.refColumns.map(cn => refMeta.columns.findIndex(c => c.name === cn));
          const parentRows = this.storage.getRows(refSchema, refTable);
          const found = parentRows.some(pRow =>
            refColIndexes.every((ri, i) => ri >= 0 && compareValues(pRow[ri], fkValues[i]) === 0));
          if (!found) {
            throw new OracleError(2291, `integrity constraint (${constraint.name}) violated - parent key not found`);
          }
        }
      }
      // CHECK constraint — parsed once per expression, evaluated per row.
      if (constraint.type === 'CHECK' && constraint.checkExpression) {
        const where = parseCheckExpression(constraint.checkExpression);
        if (!where) continue;
        try {
          if (!this.evaluateCondition(where, row, tableMeta.columns)) {
            throw new OracleError(2290, `check constraint (${constraint.name}) violated`);
          }
        } catch (e) {
          if (e instanceof OracleError && e.code === 'ORA-02290') throw e;
          // Evaluation errors (unknown identifiers, …) skip validation,
          // matching the legacy lenient behaviour.
        }
      }
    }
  }

  /** Validate data type constraints (VARCHAR2 length, NUMBER precision/scale). */
  validateDataTypes(schema: string, tableName: string, tableMeta: TableMeta, row: StorageRow): void {
    for (let i = 0; i < tableMeta.columns.length; i++) {
      const col = tableMeta.columns[i];
      const val = row[i];
      if (val === null) continue;

      const dt = col.dataType;
      const typeName = (typeof dt === 'string' ? dt : dt.name)?.toUpperCase();

      // VARCHAR2/CHAR length enforcement (ORA-12899)
      if ((typeName === 'VARCHAR2' || typeName === 'NVARCHAR2' || typeName === 'CHAR' || typeName === 'NCHAR') && typeof dt !== 'string') {
        const maxLen = dt.precision;
        if (maxLen != null && maxLen > 0) {
          const strVal = String(val);
          if (strVal.length > maxLen) {
            throw new OracleError(12899, `value too large for column "${schema}"."${tableName}"."${col.name}" (actual: ${strVal.length}, maximum: ${maxLen})`);
          }
        }
      }

      // NUMBER precision/scale enforcement (ORA-01438)
      if (typeName === 'NUMBER' && typeof dt !== 'string' && typeof val === 'number') {
        const precision = dt.precision;
        const scale = dt.scale ?? 0;
        if (precision != null && precision > 0) {
          // Oracle NUMBER(p,s): max integer digits = p - s, max decimal digits = s
          const maxIntDigits = precision - scale;
          const absVal = Math.abs(val);
          const intPart = Math.floor(absVal);
          const intDigits = intPart === 0 ? 0 : String(intPart).length;
          if (intDigits > maxIntDigits) {
            throw new OracleError(1438, `value larger than specified precision allowed for this column`);
          }
        }
      }
    }
  }

  /**
   * Enforce DELETE-side referential integrity for one parent row: apply
   * ON DELETE CASCADE / SET NULL actions, otherwise raise ORA-02292 when a
   * child row still references the key.
   */
  validateDeleteForeignKeys(schema: string, tableName: string, row: StorageRow): void {
    const tableMeta = this.storage.getTableMeta(schema, tableName);
    if (!tableMeta) return;
    // Find all tables in the same schema that have FK referencing this table
    const allTables = this.storage.getTableNames(schema);
    for (const childTableName of allTables) {
      if (childTableName === tableName) continue;
      const childMeta = this.storage.getTableMeta(schema, childTableName);
      if (!childMeta) continue;
      for (const constraint of childMeta.constraints) {
        if (constraint.type === 'FOREIGN_KEY' && constraint.refTable === tableName && constraint.refColumns) {
          const refColIndexes = constraint.refColumns.map(cn => tableMeta.columns.findIndex(c => c.name === cn));
          const parentKey = refColIndexes.map(i => i >= 0 ? row[i] : null);
          if (parentKey.some(v => v === null)) continue;
          const childColIndexes = constraint.columns.map(cn => childMeta.columns.findIndex(c => c.name === cn));
          const matchesParentKey = (cRow: StorageRow): boolean =>
            childColIndexes.every((ci, i) => ci >= 0 && compareValues(cRow[ci], parentKey[i]) === 0);
          const childRows = this.storage.getRows(schema, childTableName);
          if (!childRows.some(matchesParentKey)) continue;
          if (constraint.onDelete === 'CASCADE') {
            this.storage.deleteRows(schema, childTableName, matchesParentKey);
          } else if (constraint.onDelete === 'SET_NULL') {
            this.storage.updateRows(schema, childTableName, matchesParentKey,
              cRow => {
                const newRow = [...cRow];
                childColIndexes.forEach(ci => { if (ci >= 0) newRow[ci] = null; });
                return newRow;
              });
          } else {
            throw new OracleError(2292, `integrity constraint (${constraint.name}) violated - child record found`);
          }
        }
      }
    }
  }
}

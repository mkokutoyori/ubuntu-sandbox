/**
 * ResultSet — Query result container shared across all SQL dialects.
 */

import type { ColumnDataType } from '../catalog/DataType';

/**
 * Metadata for a single result column.
 */
export interface ColumnMeta {
  name: string;
  alias?: string;
  dataType: ColumnDataType;
  tableName?: string;
  schemaName?: string;
}

/**
 * A single row of data — values indexed by column position.
 */
export type Row = (string | number | boolean | null | Date)[];

/**
 * The result of executing a SQL statement.
 */
export interface ResultSet {
  /** Column metadata (present for queries that return rows). */
  columns: ColumnMeta[];
  /** Data rows. */
  rows: Row[];
  /** Number of rows affected (for DML: INSERT, UPDATE, DELETE). */
  affectedRows?: number;
  /** Execution time in ms (simulated). */
  executionTimeMs?: number;
  /** Whether the statement was a query (SELECT, etc.). */
  isQuery: boolean;
  /** Informational message (e.g., "Table created." "1 row inserted."). */
  message?: string;
  /** Warning messages. */
  warnings?: string[];
}

/**
 * Create an empty result set for non-query statements.
 */
export function emptyResult(message?: string, affectedRows?: number): ResultSet {
  return {
    columns: [],
    rows: [],
    affectedRows,
    isQuery: false,
    message,
  };
}

/**
 * Create a result set from query results.
 */
export function queryResult(columns: ColumnMeta[], rows: Row[]): ResultSet {
  return {
    columns,
    rows,
    isQuery: true,
  };
}

/**
 * Generic SQL Types - Base types for all SQL dialects
 */

// SQL Data Types
export type SQLDataType =
  | 'INTEGER' | 'BIGINT' | 'SMALLINT' | 'TINYINT'
  | 'DECIMAL' | 'NUMERIC' | 'FLOAT' | 'DOUBLE' | 'REAL'
  | 'CHAR' | 'VARCHAR' | 'TEXT' | 'CLOB'
  | 'DATE' | 'TIME' | 'TIMESTAMP' | 'DATETIME'
  | 'BOOLEAN'
  | 'BLOB' | 'BINARY' | 'VARBINARY'
  | 'JSON' | 'XML';

export interface ColumnDefinition {
  name: string;
  dataType: SQLDataType;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  defaultValue?: SQLValue;
  primaryKey: boolean;
  unique: boolean;
  autoIncrement: boolean;
  references?: ForeignKeyRef;
  check?: string;
}

export interface ForeignKeyRef {
  table: string;
  column: string;
  onDelete?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
}

export interface IndexDefinition {
  name: string;
  columns: string[];
  unique: boolean;
  type?: 'BTREE' | 'HASH' | 'BITMAP';
}

export interface TableDefinition {
  name: string;
  schema?: string;
  columns: ColumnDefinition[];
  primaryKey?: string[];
  indexes: IndexDefinition[];
  foreignKeys: ForeignKeyConstraint[];
  checkConstraints: CheckConstraint[];
}

export interface ForeignKeyConstraint {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
  onUpdate?: 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION';
}

export interface CheckConstraint {
  name: string;
  expression: string;
}

// SQL Values
export type SQLValue = string | number | boolean | null | Date | Buffer | SQLValue[];

export interface SQLRow {
  [column: string]: SQLValue;
}

// Query Results
export interface SQLResultSet {
  columns: string[];
  columnTypes: SQLDataType[];
  rows: SQLRow[];
  rowCount: number;
  affectedRows?: number;
}

export interface SQLError {
  code: string;
  message: string;
  line?: number;
  position?: number;
}

export interface SQLResult {
  success: boolean;
  resultSet?: SQLResultSet;
  affectedRows?: number;
  lastInsertId?: number;
  error?: SQLError;
  warnings?: string[];
  executionTime?: number;
}

// Transaction
export interface Transaction {
  id: string;
  startTime: Date;
  isolationLevel: IsolationLevel;
  operations: TransactionOperation[];
  savepoints: string[];
}

export type IsolationLevel =
  | 'READ UNCOMMITTED'
  | 'READ COMMITTED'
  | 'REPEATABLE READ'
  | 'SERIALIZABLE';

export interface TransactionOperation {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  oldData?: SQLRow[];
  newData?: SQLRow[];
}

// User and Privileges
export interface SQLUser {
  name: string;
  password?: string;
  createdAt: Date;
  locked: boolean;
  passwordExpired: boolean;
  defaultSchema?: string;
  profile?: string;
}

export type PrivilegeType =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'CREATE' | 'ALTER' | 'DROP' | 'INDEX'
  | 'REFERENCES' | 'EXECUTE' | 'ALL';

export interface Privilege {
  type: PrivilegeType;
  grantee: string;
  grantor: string;
  objectType?: 'TABLE' | 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'SEQUENCE' | 'SCHEMA';
  objectName?: string;
  withGrantOption: boolean;
}

export interface Role {
  name: string;
  privileges: Privilege[];
  members: string[];
}

// Schema objects
export interface ViewDefinition {
  name: string;
  schema?: string;
  query: string;
  columns?: string[];
  withCheckOption: boolean;
}

export interface SequenceDefinition {
  name: string;
  schema?: string;
  startWith: number;
  incrementBy: number;
  minValue?: number;
  maxValue?: number;
  cycle: boolean;
  cache: number;
  currentValue: number;
}

export interface ProcedureDefinition {
  name: string;
  schema?: string;
  parameters: ProcedureParameter[];
  body: string;
  language: string;
  returnType?: SQLDataType;
  isFunction: boolean;
}

export interface ProcedureParameter {
  name: string;
  dataType: SQLDataType;
  mode: 'IN' | 'OUT' | 'INOUT';
  defaultValue?: SQLValue;
}

export interface TriggerDefinition {
  name: string;
  table: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: ('INSERT' | 'UPDATE' | 'DELETE')[];
  forEach: 'ROW' | 'STATEMENT';
  condition?: string;
  body: string;
  enabled: boolean;
}

// Database Schema
export interface SchemaDefinition {
  name: string;
  owner: string;
  tables: Map<string, TableDefinition>;
  views: Map<string, ViewDefinition>;
  sequences: Map<string, SequenceDefinition>;
  procedures: Map<string, ProcedureDefinition>;
  triggers: Map<string, TriggerDefinition>;
}

// Database Instance
export interface DatabaseInstance {
  name: string;
  schemas: Map<string, SchemaDefinition>;
  users: Map<string, SQLUser>;
  roles: Map<string, Role>;
  privileges: Privilege[];
  currentUser: string;
  currentSchema: string;
  config: DatabaseConfig;
}

export interface DatabaseConfig {
  caseSensitiveIdentifiers: boolean;
  defaultSchema: string;
  dateFormat: string;
  timestampFormat: string;
  maxRowsReturn: number;
  autoCommit: boolean;
}

// Session
export interface SQLSession {
  id: string;
  user: string;
  schema: string;
  database: DatabaseInstance;
  transaction: Transaction | null;
  variables: Map<string, SQLValue>;
  settings: SessionSettings;
  startTime: Date;
}

export interface SessionSettings {
  autoCommit: boolean;
  echoCommands: boolean;
  timing: boolean;
  lineSize: number;
  pageSize: number;
  feedback: boolean;
  heading: boolean;
  nullDisplay: string;
}

// AST Node Types for SQL Parser
export type SQLStatementType =
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'CREATE_TABLE' | 'CREATE_VIEW' | 'CREATE_INDEX' | 'CREATE_SEQUENCE'
  | 'CREATE_PROCEDURE' | 'CREATE_FUNCTION' | 'CREATE_TRIGGER'
  | 'CREATE_USER' | 'CREATE_ROLE' | 'CREATE_SCHEMA'
  | 'ALTER_TABLE' | 'ALTER_USER' | 'ALTER_SEQUENCE'
  | 'DROP_TABLE' | 'DROP_VIEW' | 'DROP_INDEX' | 'DROP_SEQUENCE'
  | 'DROP_PROCEDURE' | 'DROP_FUNCTION' | 'DROP_TRIGGER'
  | 'DROP_USER' | 'DROP_ROLE' | 'DROP_SCHEMA'
  | 'GRANT' | 'REVOKE'
  | 'BEGIN' | 'COMMIT' | 'ROLLBACK' | 'SAVEPOINT'
  | 'TRUNCATE' | 'DESCRIBE' | 'EXPLAIN'
  | 'SET' | 'SHOW' | 'USE'
  | 'CALL' | 'EXECUTE';

export interface SQLStatement {
  type: SQLStatementType;
  // Specific properties will be defined in dialect extensions
}

// Expression types
export type ExpressionType =
  | 'LITERAL' | 'IDENTIFIER' | 'COLUMN_REF'
  | 'BINARY_OP' | 'UNARY_OP' | 'FUNCTION_CALL'
  | 'CASE' | 'CAST' | 'SUBQUERY'
  | 'EXISTS' | 'IN' | 'BETWEEN' | 'LIKE' | 'IS_NULL'
  | 'AND' | 'OR' | 'NOT'
  | 'PARAMETER' | 'AGGREGATE';

export interface SQLExpression {
  type: ExpressionType;
  value?: SQLValue;
  name?: string;
  left?: SQLExpression;
  right?: SQLExpression;
  operator?: string;
  arguments?: SQLExpression[];
  alias?: string;
}

// Table reference for FROM clause
export interface TableReference {
  table: string;
  schema?: string;
  alias?: string;
  joinType?: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';
  joinCondition?: SQLExpression;
  subquery?: SelectStatement;
}

// SELECT statement
export interface SelectStatement extends SQLStatement {
  type: 'SELECT';
  distinct: boolean;
  columns: SelectColumn[];
  from: TableReference[];
  where?: SQLExpression;
  groupBy?: SQLExpression[];
  having?: SQLExpression;
  orderBy?: OrderByItem[];
  limit?: number;
  offset?: number;
  forUpdate?: boolean;
}

export interface SelectColumn {
  expression: SQLExpression;
  alias?: string;
  all?: boolean; // for table.*
}

export interface OrderByItem {
  expression: SQLExpression;
  direction: 'ASC' | 'DESC';
  nulls?: 'FIRST' | 'LAST';
}

// INSERT statement
export interface InsertStatement extends SQLStatement {
  type: 'INSERT';
  table: string;
  schema?: string;
  columns?: string[];
  values?: SQLValue[][];
  select?: SelectStatement;
  onConflict?: 'IGNORE' | 'REPLACE' | 'UPDATE';
  returning?: SelectColumn[];
}

// UPDATE statement
export interface UpdateStatement extends SQLStatement {
  type: 'UPDATE';
  table: string;
  schema?: string;
  alias?: string;
  set: { column: string; value: SQLExpression }[];
  from?: TableReference[];
  where?: SQLExpression;
  returning?: SelectColumn[];
}

// DELETE statement
export interface DeleteStatement extends SQLStatement {
  type: 'DELETE';
  table: string;
  schema?: string;
  alias?: string;
  using?: TableReference[];
  where?: SQLExpression;
  returning?: SelectColumn[];
}

// CREATE TABLE statement
export interface CreateTableStatement extends SQLStatement {
  type: 'CREATE_TABLE';
  table: string;
  schema?: string;
  ifNotExists: boolean;
  columns: ColumnDefinition[];
  primaryKey?: string[];
  foreignKeys: ForeignKeyConstraint[];
  checkConstraints: CheckConstraint[];
  indexes: IndexDefinition[];
  temporary: boolean;
  asSelect?: SelectStatement;
}

// Utility functions
export function createEmptyResultSet(): SQLResultSet {
  return {
    columns: [],
    columnTypes: [],
    rows: [],
    rowCount: 0
  };
}

export function createErrorResult(code: string, message: string): SQLResult {
  return {
    success: false,
    error: { code, message }
  };
}

export function createSuccessResult(affectedRows: number = 0): SQLResult {
  return {
    success: true,
    affectedRows
  };
}

export function sqlValueToString(value: SQLValue, nullDisplay: string = 'NULL'): string {
  if (value === null) return nullDisplay;
  if (value === undefined) return nullDisplay;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<BLOB ${value.length} bytes>`;
  if (Array.isArray(value)) return `[${value.map(v => sqlValueToString(v, nullDisplay)).join(', ')}]`;
  return String(value);
}

export function compareSQLValues(a: SQLValue, b: SQLValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  return String(a).localeCompare(String(b));
}

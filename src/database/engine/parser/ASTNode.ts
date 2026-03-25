/**
 * ASTNode — Abstract Syntax Tree nodes for SQL statements.
 *
 * Shared across all SQL dialects. Dialect-specific nodes (e.g., Oracle's
 * CONNECT BY, PG's RETURNING) extend these base interfaces.
 *
 * All nodes carry a `position` for error reporting.
 */

import type { SourcePosition } from '../lexer/Token';

// ── Base ────────────────────────────────────────────────────────────

export interface ASTNode {
  type: string;
  position: SourcePosition;
}

// ── Expressions ─────────────────────────────────────────────────────

export interface LiteralExpr extends ASTNode {
  type: 'Literal';
  dataType: 'number' | 'string' | 'null' | 'boolean' | 'date' | 'timestamp' | 'interval';
  value: string | number | null | boolean;
}

export interface IdentifierExpr extends ASTNode {
  type: 'Identifier';
  /** Optional schema/table qualifier */
  schema?: string;
  table?: string;
  name: string;
}

export interface StarExpr extends ASTNode {
  type: 'Star';
  /** Optional table qualifier: table.* */
  table?: string;
}

export interface BinaryExpr extends ASTNode {
  type: 'BinaryExpr';
  operator: string;
  left: Expression;
  right: Expression;
}

export interface UnaryExpr extends ASTNode {
  type: 'UnaryExpr';
  operator: string; // NOT, -, +, EXISTS
  operand: Expression;
}

export interface BetweenExpr extends ASTNode {
  type: 'BetweenExpr';
  expr: Expression;
  low: Expression;
  high: Expression;
  negated: boolean;
}

export interface InExpr extends ASTNode {
  type: 'InExpr';
  expr: Expression;
  values: Expression[] | SelectStatement;
  negated: boolean;
}

export interface LikeExpr extends ASTNode {
  type: 'LikeExpr';
  expr: Expression;
  pattern: Expression;
  escape?: Expression;
  negated: boolean;
}

export interface IsNullExpr extends ASTNode {
  type: 'IsNullExpr';
  expr: Expression;
  negated: boolean;
}

export interface FunctionCallExpr extends ASTNode {
  type: 'FunctionCall';
  schema?: string;
  name: string;
  args: Expression[];
  distinct?: boolean;
  /** Analytic window specification */
  over?: WindowSpec;
}

export interface CaseExpr extends ASTNode {
  type: 'CaseExpr';
  /** Simple CASE: the value being compared */
  operand?: Expression;
  whenClauses: { when: Expression; then: Expression }[];
  elseClause?: Expression;
}

export interface SubqueryExpr extends ASTNode {
  type: 'SubqueryExpr';
  query: SelectStatement;
}

export interface CastExpr extends ASTNode {
  type: 'CastExpr';
  expr: Expression;
  targetType: TypeSpec;
}

export interface SequenceExpr extends ASTNode {
  type: 'SequenceExpr';
  schema?: string;
  sequenceName: string;
  operation: 'NEXTVAL' | 'CURRVAL';
}

export interface BindVariableExpr extends ASTNode {
  type: 'BindVariable';
  name: string;
}

export interface ParenExpr extends ASTNode {
  type: 'ParenExpr';
  expr: Expression;
}

/** Union of all expression types. */
export type Expression =
  | LiteralExpr | IdentifierExpr | StarExpr
  | BinaryExpr | UnaryExpr
  | BetweenExpr | InExpr | LikeExpr | IsNullExpr
  | FunctionCallExpr | CaseExpr | SubqueryExpr
  | CastExpr | SequenceExpr | BindVariableExpr | ParenExpr;

// ── Type specifications ─────────────────────────────────────────────

export interface TypeSpec extends ASTNode {
  type: 'TypeSpec';
  name: string;
  precision?: number;
  scale?: number;
}

// ── Window / Analytic ───────────────────────────────────────────────

export interface WindowSpec {
  partitionBy?: Expression[];
  orderBy?: OrderByItem[];
  frame?: WindowFrame;
}

export interface WindowFrame {
  type: 'ROWS' | 'RANGE';
  start: FrameBound;
  end?: FrameBound;
}

export interface FrameBound {
  type: 'UNBOUNDED_PRECEDING' | 'UNBOUNDED_FOLLOWING' | 'CURRENT_ROW' | 'PRECEDING' | 'FOLLOWING';
  value?: Expression;
}

// ── Select Items & Clauses ──────────────────────────────────────────

export interface SelectItem extends ASTNode {
  type: 'SelectItem';
  expr: Expression;
  alias?: string;
}

export interface OrderByItem extends ASTNode {
  type: 'OrderByItem';
  expr: Expression;
  direction: 'ASC' | 'DESC';
  nullsPosition?: 'FIRST' | 'LAST';
}

// ── Table References ────────────────────────────────────────────────

export interface TableRef extends ASTNode {
  type: 'TableRef';
  schema?: string;
  name: string;
  alias?: string;
  dbLink?: string;
}

export interface SubqueryTableRef extends ASTNode {
  type: 'SubqueryTableRef';
  query: SelectStatement;
  alias: string;
}

export interface JoinClause extends ASTNode {
  type: 'JoinClause';
  joinType: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS' | 'NATURAL';
  table: TableReference;
  on?: Expression;
  using?: string[];
}

export type TableReference = TableRef | SubqueryTableRef;

// ── WITH clause (CTE) ──────────────────────────────────────────────

export interface WithClause extends ASTNode {
  type: 'WithClause';
  recursive: boolean;
  ctes: CTEDefinition[];
}

export interface CTEDefinition extends ASTNode {
  type: 'CTEDefinition';
  name: string;
  columns?: string[];
  query: SelectStatement;
}

// ── Hierarchical Query (Oracle) ─────────────────────────────────────

export interface ConnectByClause extends ASTNode {
  type: 'ConnectByClause';
  condition: Expression;
  noCycle: boolean;
  startWith?: Expression;
}

// ── RETURNING clause ────────────────────────────────────────────────

export interface ReturningClause extends ASTNode {
  type: 'ReturningClause';
  columns: Expression[];
  into: string[];
}

// ── Constraint definitions ──────────────────────────────────────────

export interface ColumnConstraint extends ASTNode {
  type: 'ColumnConstraint';
  constraintName?: string;
  constraintType: 'NOT_NULL' | 'NULL' | 'UNIQUE' | 'PRIMARY_KEY' | 'CHECK' | 'REFERENCES';
  checkExpr?: Expression;
  refTable?: string;
  refColumn?: string;
  onDelete?: 'CASCADE' | 'SET_NULL';
  enable?: boolean;
  deferrable?: boolean;
}

export interface TableConstraint extends ASTNode {
  type: 'TableConstraint';
  constraintName?: string;
  constraintType: 'UNIQUE' | 'PRIMARY_KEY' | 'FOREIGN_KEY' | 'CHECK';
  columns: string[];
  checkExpr?: Expression;
  refTable?: string;
  refColumns?: string[];
  onDelete?: 'CASCADE' | 'SET_NULL';
}

// ── Column Definition ───────────────────────────────────────────────

export interface ColumnDefinition extends ASTNode {
  type: 'ColumnDefinition';
  name: string;
  dataType: TypeSpec;
  defaultValue?: Expression;
  identity?: { always: boolean };
  constraints: ColumnConstraint[];
}

// ── Assignment (for UPDATE SET) ─────────────────────────────────────

export interface Assignment extends ASTNode {
  type: 'Assignment';
  column: string;
  value: Expression;
}

// ── Statements ──────────────────────────────────────────────────────

export interface SelectStatement extends ASTNode {
  type: 'SelectStatement';
  withClause?: WithClause;
  distinct?: boolean;
  columns: SelectItem[];
  from?: TableReference[];
  joins?: JoinClause[];
  where?: Expression;
  connectBy?: ConnectByClause;
  groupBy?: Expression[];
  having?: Expression;
  orderBy?: OrderByItem[];
  fetch?: { offset?: Expression; count?: Expression; percent?: boolean; withTies?: boolean };
  forUpdate?: { columns?: string[]; wait?: number | 'NOWAIT' | 'SKIP_LOCKED' };
  /** Set operations */
  setOp?: { op: 'UNION' | 'UNION_ALL' | 'INTERSECT' | 'MINUS' | 'EXCEPT'; right: SelectStatement };
}

export interface InsertStatement extends ASTNode {
  type: 'InsertStatement';
  table: TableRef;
  columns?: string[];
  values?: Expression[][];
  query?: SelectStatement;
  returning?: ReturningClause;
}

export interface UpdateStatement extends ASTNode {
  type: 'UpdateStatement';
  table: TableRef;
  assignments: Assignment[];
  where?: Expression;
  returning?: ReturningClause;
}

export interface DeleteStatement extends ASTNode {
  type: 'DeleteStatement';
  table: TableRef;
  where?: Expression;
  returning?: ReturningClause;
}

export interface MergeStatement extends ASTNode {
  type: 'MergeStatement';
  target: TableRef;
  source: TableReference;
  on: Expression;
  whenMatched?: { assignments: Assignment[]; where?: Expression; deleteWhere?: Expression };
  whenNotMatched?: { columns: string[]; values: Expression[]; where?: Expression };
}

// ── DDL Statements ──────────────────────────────────────────────────

export interface CreateTableStatement extends ASTNode {
  type: 'CreateTableStatement';
  orReplace?: boolean;
  temporary?: boolean;
  schema?: string;
  name: string;
  columns: ColumnDefinition[];
  constraints: TableConstraint[];
  tablespace?: string;
  asSelect?: SelectStatement;
  onCommit?: 'DELETE_ROWS' | 'PRESERVE_ROWS';
}

export interface AlterTableStatement extends ASTNode {
  type: 'AlterTableStatement';
  schema?: string;
  name: string;
  actions: AlterTableAction[];
}

export type AlterTableAction =
  | { action: 'ADD_COLUMN'; column: ColumnDefinition }
  | { action: 'MODIFY_COLUMN'; column: ColumnDefinition }
  | { action: 'DROP_COLUMN'; columnName: string }
  | { action: 'ADD_CONSTRAINT'; constraint: TableConstraint }
  | { action: 'DROP_CONSTRAINT'; constraintName: string; cascade?: boolean }
  | { action: 'RENAME_COLUMN'; oldName: string; newName: string }
  | { action: 'RENAME_TABLE'; newName: string };

export interface DropTableStatement extends ASTNode {
  type: 'DropTableStatement';
  schema?: string;
  name: string;
  cascade?: boolean;
  purge?: boolean;
  ifExists?: boolean;
}

export interface TruncateTableStatement extends ASTNode {
  type: 'TruncateTableStatement';
  schema?: string;
  name: string;
}

export interface CreateIndexStatement extends ASTNode {
  type: 'CreateIndexStatement';
  unique?: boolean;
  bitmap?: boolean;
  schema?: string;
  name: string;
  table: string;
  tableSchema?: string;
  columns: { name: string; expr?: Expression; direction?: 'ASC' | 'DESC'; expression?: string }[];
  tablespace?: string;
}

export interface DropIndexStatement extends ASTNode {
  type: 'DropIndexStatement';
  schema?: string;
  name: string;
}

export interface CreateSequenceStatement extends ASTNode {
  type: 'CreateSequenceStatement';
  schema?: string;
  name: string;
  startWith?: number;
  incrementBy?: number;
  minValue?: number | 'NOMINVALUE';
  maxValue?: number | 'NOMAXVALUE';
  cache?: number | 'NOCACHE';
  cycle?: boolean;
  order?: boolean;
}

export interface DropSequenceStatement extends ASTNode {
  type: 'DropSequenceStatement';
  schema?: string;
  name: string;
}

export interface CreateViewStatement extends ASTNode {
  type: 'CreateViewStatement';
  orReplace?: boolean;
  force?: boolean;
  schema?: string;
  name: string;
  columns?: string[];
  query: SelectStatement;
  withCheckOption?: boolean;
  withReadOnly?: boolean;
}

export interface DropViewStatement extends ASTNode {
  type: 'DropViewStatement';
  schema?: string;
  name: string;
  cascade?: boolean;
}

// ── DCL Statements (Privileges) ─────────────────────────────────────

export interface GrantStatement extends ASTNode {
  type: 'GrantStatement';
  privileges: string[];
  objectType?: string;
  objectSchema?: string;
  objectName?: string;
  grantee: string;
  withGrantOption?: boolean;
  withAdminOption?: boolean;
}

export interface RevokeStatement extends ASTNode {
  type: 'RevokeStatement';
  privileges: string[];
  objectType?: string;
  objectSchema?: string;
  objectName?: string;
  grantee: string;
}

// ── User/Role Management ────────────────────────────────────────────

export interface CreateUserStatement extends ASTNode {
  type: 'CreateUserStatement';
  username: string;
  password?: string;
  defaultTablespace?: string;
  temporaryTablespace?: string;
  quota?: { size: string; tablespace: string }[];
  profile?: string;
  accountLocked?: boolean;
  passwordExpired?: boolean;
}

export interface AlterUserStatement extends ASTNode {
  type: 'AlterUserStatement';
  username: string;
  password?: string;
  defaultTablespace?: string;
  temporaryTablespace?: string;
  quota?: { size: string; tablespace: string }[];
  profile?: string;
  accountLock?: boolean;
  accountUnlock?: boolean;
  passwordExpire?: boolean;
}

export interface DropUserStatement extends ASTNode {
  type: 'DropUserStatement';
  username: string;
  cascade?: boolean;
}

export interface CreateRoleStatement extends ASTNode {
  type: 'CreateRoleStatement';
  name: string;
}

export interface DropRoleStatement extends ASTNode {
  type: 'DropRoleStatement';
  name: string;
}

// ── Transaction Statements ──────────────────────────────────────────

export interface CommitStatement extends ASTNode {
  type: 'CommitStatement';
}

export interface RollbackStatement extends ASTNode {
  type: 'RollbackStatement';
  savepoint?: string;
}

export interface SavepointStatement extends ASTNode {
  type: 'SavepointStatement';
  name: string;
}

export interface SetTransactionStatement extends ASTNode {
  type: 'SetTransactionStatement';
  isolationLevel?: 'READ_COMMITTED' | 'SERIALIZABLE';
  readOnly?: boolean;
}

// ── Oracle Instance Commands ────────────────────────────────────────

export interface StartupStatement extends ASTNode {
  type: 'StartupStatement';
  mode?: 'NOMOUNT' | 'MOUNT' | 'RESTRICT' | 'FORCE';
}

export interface ShutdownStatement extends ASTNode {
  type: 'ShutdownStatement';
  mode?: 'NORMAL' | 'IMMEDIATE' | 'TRANSACTIONAL' | 'ABORT';
}

export interface AlterSystemStatement extends ASTNode {
  type: 'AlterSystemStatement';
  action: string;
  parameter?: string;
  value?: string;
  scope?: 'MEMORY' | 'SPFILE' | 'BOTH';
}

export interface AlterDatabaseStatement extends ASTNode {
  type: 'AlterDatabaseStatement';
  action: string;
  details?: string;
}

// ── Tablespace Statements ───────────────────────────────────────────

export interface CreateTablespaceStatement extends ASTNode {
  type: 'CreateTablespaceStatement';
  name: string;
  temporary?: boolean;
  undo?: boolean;
  datafile: string;
  size: string;
  autoextend?: { on: boolean; next?: string; maxSize?: string };
}

export interface DropTablespaceStatement extends ASTNode {
  type: 'DropTablespaceStatement';
  name: string;
  includeContents?: boolean;
  includeDatafiles?: boolean;
}

// ── PL/SQL Blocks (basic) ───────────────────────────────────────────

export interface PLSQLBlock extends ASTNode {
  type: 'PLSQLBlock';
  declarations: PLSQLDeclaration[];
  body: PLSQLStatement[];
  exceptionHandlers: PLSQLExceptionHandler[];
}

export interface PLSQLDeclaration extends ASTNode {
  type: 'PLSQLDeclaration';
  name: string;
  dataType?: TypeSpec;
  constant?: boolean;
  notNull?: boolean;
  defaultValue?: Expression;
  anchorType?: string;   // %TYPE, %ROWTYPE
  anchorRef?: string;    // table.column%TYPE
}

export interface PLSQLStatement extends ASTNode {
  type: 'PLSQLStatement';
  statementType: string;
  body: string;
}

export interface PLSQLExceptionHandler extends ASTNode {
  type: 'PLSQLExceptionHandler';
  exceptionName: string;
  body: PLSQLStatement[];
}

// ── CREATE TRIGGER ──────────────────────────────────────────────────

export interface CreateTriggerStatement extends ASTNode {
  type: 'CreateTriggerStatement';
  orReplace?: boolean;
  schema?: string;
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: Array<'INSERT' | 'UPDATE' | 'DELETE'>;
  tableName: string;
  tableSchema?: string;
  forEachRow?: boolean;
  whenCondition?: string;
  body: string;
}

export interface DropTriggerStatement extends ASTNode {
  type: 'DropTriggerStatement';
  schema?: string;
  name: string;
}

// ── EXPLAIN PLAN ────────────────────────────────────────────────────

export interface ExplainPlanStatement extends ASTNode {
  type: 'ExplainPlanStatement';
  statementId?: string;
  targetTable?: string;
  statement: Statement;
}

// ── Synonym ─────────────────────────────────────────────────────────

export interface CreateSynonymStatement extends ASTNode {
  type: 'CreateSynonymStatement';
  orReplace?: boolean;
  isPublic?: boolean;
  schema?: string;
  name: string;
  targetSchema?: string;
  targetName: string;
}

export interface DropSynonymStatement extends ASTNode {
  type: 'DropSynonymStatement';
  isPublic?: boolean;
  schema?: string;
  name: string;
}

// ── ALTER SEQUENCE ──────────────────────────────────────────────────

export interface AlterSequenceStatement extends ASTNode {
  type: 'AlterSequenceStatement';
  schema?: string;
  name: string;
  incrementBy?: number;
  minValue?: number;
  maxValue?: number;
  cache?: number;
  cycle?: boolean;
}

// ── ALTER INDEX ─────────────────────────────────────────────────────

export interface AlterIndexStatement extends ASTNode {
  type: 'AlterIndexStatement';
  schema?: string;
  name: string;
  action: 'REBUILD' | 'RENAME';
  newName?: string;
}

// ── Top-level statement union ───────────────────────────────────────

export type Statement =
  // DML
  | SelectStatement | InsertStatement | UpdateStatement | DeleteStatement | MergeStatement
  // DDL
  | CreateTableStatement | AlterTableStatement | DropTableStatement | TruncateTableStatement
  | CreateIndexStatement | DropIndexStatement
  | CreateSequenceStatement | DropSequenceStatement
  | CreateViewStatement | DropViewStatement
  // DCL
  | GrantStatement | RevokeStatement
  // User/Role
  | CreateUserStatement | AlterUserStatement | DropUserStatement
  | CreateRoleStatement | DropRoleStatement
  // Transaction
  | CommitStatement | RollbackStatement | SavepointStatement | SetTransactionStatement
  // Oracle admin
  | StartupStatement | ShutdownStatement | AlterSystemStatement | AlterDatabaseStatement
  | CreateTablespaceStatement | DropTablespaceStatement
  // Explain
  | ExplainPlanStatement
  // Triggers
  | CreateTriggerStatement | DropTriggerStatement
  // Synonyms
  | CreateSynonymStatement | DropSynonymStatement
  // Alter
  | AlterSequenceStatement | AlterIndexStatement
  // PL/SQL
  | PLSQLBlock;

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
  partitioning?: PartitioningClause;
}

export interface PartitioningClause {
  type: 'PartitioningClause';
  strategy: 'RANGE' | 'LIST' | 'HASH' | 'REFERENCE' | 'SYSTEM';
  columns: string[];
  interval?: string;
  partitions: PartitionSpec[];
}

export interface PartitionSpec {
  name: string;
  highValue?: string;
  tablespace?: string;
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
  | { action: 'RENAME_TABLE'; newName: string }
  | { action: 'MOVE_TABLESPACE'; tablespace: string }
  | { action: 'MOVE_COMPRESS'; compressionLevel?: string }
  | { action: 'SHRINK_SPACE'; compact?: boolean; cascade?: boolean }
  | { action: 'ROW_MOVEMENT'; enabled: boolean }
  | { action: 'ADD_SUPPLEMENTAL_LOG_GROUP'; logGroupName: string; columns: string[]; always: boolean }
  | { action: 'DROP_SUPPLEMENTAL_LOG_GROUP'; logGroupName: string }
  | { action: 'ADD_SUPPLEMENTAL_LOG_DATA'; mode: 'PRIMARY_KEY' | 'UNIQUE' | 'FOREIGN_KEY' | 'ALL' }
  | { action: 'ENCRYPT_COLUMN'; columnName: string; algorithm?: string; salt?: boolean; integrity?: string }
  | { action: 'DECRYPT_COLUMN'; columnName: string };

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
  /** All grantees specified after TO — at least one element. */
  grantees: string[];
  /** Convenience alias for grantees[0]; preserved for legacy consumers. */
  grantee: string;
  /**
   * Column list collected from `priv(col1, col2, …)` clauses. Keyed by the
   * upper-cased privilege name so `GRANT SELECT(a), UPDATE(b)` round-trips
   * cleanly. Absent entries denote a whole-table grant.
   */
  privilegeColumns?: Record<string, string[]>;
  withGrantOption?: boolean;
  withAdminOption?: boolean;
}

export interface RevokeStatement extends ASTNode {
  type: 'RevokeStatement';
  privileges: string[];
  objectType?: string;
  objectSchema?: string;
  objectName?: string;
  grantees: string[];
  grantee: string;
  privilegeColumns?: Record<string, string[]>;
  /**
   * Present when the statement is `REVOKE {ADMIN|GRANT} OPTION FOR p
   * FROM g` — the privilege itself is preserved, only the option is
   * stripped from the dictionary row.
   */
  strippingOption?: 'ADMIN' | 'GRANT';
}

// ── User/Role Management ────────────────────────────────────────────

export interface CreateUserStatement extends ASTNode {
  type: 'CreateUserStatement';
  username: string;
  password?: string;
  /** EXTERNAL: OS-authenticated; GLOBAL: directory-authenticated. */
  authenticationKind?: 'PASSWORD' | 'EXTERNAL' | 'GLOBAL';
  /** Distinguished name for GLOBAL auth (IDENTIFIED GLOBALLY AS '...'). */
  externalName?: string;
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
  /** Switch authentication kind via IDENTIFIED EXTERNALLY / GLOBALLY. */
  authenticationKind?: 'PASSWORD' | 'EXTERNAL' | 'GLOBAL';
  /** Optional principal / DN that follows AS '<…>' in the IDENTIFIED clause. */
  externalName?: string;
  defaultTablespace?: string;
  temporaryTablespace?: string;
  quota?: { size: string; tablespace: string }[];
  profile?: string;
  accountLock?: boolean;
  accountUnlock?: boolean;
  passwordExpire?: boolean;
  /**
   * `DEFAULT ROLE …` clause. Mirrors Oracle's modes:
   *   ALL                 → every granted role default-on (the implicit default)
   *   NONE                → no role default-on
   *   LIST {r1, r2, …}    → only the named roles default-on
   *   EXCEPT {r1, …}      → every role default-on except the named ones
   */
  defaultRoleSpec?: { mode: 'ALL' | 'NONE' | 'LIST' | 'EXCEPT'; roles: string[] };
  /**
   * Set when the statement uses `IDENTIFIED BY VALUES '<hash>'` — the
   * password literal is an already-hashed verifier, not a clear-text
   * password. The simulator accepts the hash as the new password but
   * does not attempt to interpret it.
   */
  passwordByHash?: boolean;
  /**
   * `REPLACE <oldPassword>` suffix on `IDENTIFIED BY new`. Captured so
   * the executor could enforce the user's existing password when the
   * profile demands it; for now we only validate the syntax.
   */
  replacePassword?: string;
  /**
   * `GRANT|REVOKE CONNECT THROUGH <proxy> [WITH ROLE <role>]` proxy-
   * authentication clause. The simulator persists it through the
   * catalog so `PROXY_USERS` reports the relationship.
   */
  proxy?: { mode: 'GRANT' | 'REVOKE'; proxy: string; role?: string };
}

export interface DropUserStatement extends ASTNode {
  type: 'DropUserStatement';
  username: string;
  cascade?: boolean;
}

export interface CreateRoleStatement extends ASTNode {
  type: 'CreateRoleStatement';
  name: string;
  /**
   * How holders of the role must authenticate when SET ROLE is issued:
   *   - `'NONE'` — default, role is enabled without a credential;
   *   - `'PASSWORD'` — explicit `IDENTIFIED BY <pw>`;
   *   - `'EXTERNAL'` — `IDENTIFIED EXTERNALLY`;
   *   - `'GLOBAL'`   — `IDENTIFIED GLOBALLY`.
   */
  authenticationKind?: 'NONE' | 'PASSWORD' | 'EXTERNAL' | 'GLOBAL';
  password?: string;
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
  /** For KILL SESSION / DISCONNECT SESSION: 'sid,serial#' */
  sessionId?: string;
  /** For KILL SESSION: IMMEDIATE flag */
  immediate?: boolean;
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
  /** Optional storage-attribute clauses — propagated to TablespaceMeta. */
  logging?: boolean;
  extentManagement?: 'LOCAL' | 'DICTIONARY';
  segmentSpaceManagement?: 'AUTO' | 'MANUAL';
  allocationType?: 'SYSTEM' | 'UNIFORM' | 'USER';
  encrypted?: boolean;
}

export interface DropTablespaceStatement extends ASTNode {
  type: 'DropTablespaceStatement';
  name: string;
  includeContents?: boolean;
  includeDatafiles?: boolean;
}

export type AlterTablespaceAction =
  | { kind: 'ADD_DATAFILE'; path: string; size: string; autoextend?: boolean }
  | { kind: 'ONLINE' }
  | { kind: 'OFFLINE'; mode?: 'NORMAL' | 'TEMPORARY' | 'IMMEDIATE' }
  | { kind: 'READ_ONLY' }
  | { kind: 'READ_WRITE' }
  | { kind: 'RENAME_TO'; newName: string }
  | { kind: 'BEGIN_BACKUP' }
  | { kind: 'END_BACKUP' }
  | { kind: 'LOGGING' }
  | { kind: 'NOLOGGING' }
  | { kind: 'FORCE_LOGGING' }
  | { kind: 'NO_FORCE_LOGGING' }
  | { kind: 'FLASHBACK_ON' }
  | { kind: 'FLASHBACK_OFF' }
  | { kind: 'SHRINK_SPACE' }
  | { kind: 'COALESCE' }
  | { kind: 'RENAME_DATAFILE'; oldPath: string; newPath: string };

export interface AlterTablespaceStatement extends ASTNode {
  type: 'AlterTablespaceStatement';
  name: string;
  action: AlterTablespaceAction;
}

export interface CreateDiskgroupStatement extends ASTNode {
  type: 'CreateDiskgroupStatement';
  name: string;
  redundancy: 'EXTERNAL' | 'NORMAL' | 'HIGH';
  /** Disks paired with their literal paths (and optional NAME / SIZE). */
  disks: { path: string; name?: string; sizeMb?: number }[];
}

export interface DropDiskgroupStatement extends ASTNode {
  type: 'DropDiskgroupStatement';
  name: string;
  includingContents: boolean;
}

export type AlterDiskgroupAction =
  | { kind: 'ADD_DISK'; disks: { path: string; name?: string; sizeMb?: number; failgroup?: string }[] }
  | { kind: 'DROP_DISK'; identifiers: string[] }
  | { kind: 'REBALANCE'; power?: number }
  | { kind: 'MOUNT' }
  | { kind: 'DISMOUNT' };

export interface AlterDiskgroupStatement extends ASTNode {
  type: 'AlterDiskgroupStatement';
  name: string;
  action: AlterDiskgroupAction;
}

export interface AnalyzeStatement extends ASTNode {
  type: 'AnalyzeStatement';
  /** TABLE | INDEX | CLUSTER. */
  target: 'TABLE' | 'INDEX' | 'CLUSTER';
  schema?: string;
  name: string;
  /** COMPUTE STATISTICS | ESTIMATE STATISTICS | VALIDATE STRUCTURE | DELETE STATISTICS. */
  action: 'COMPUTE_STATISTICS' | 'ESTIMATE_STATISTICS' | 'VALIDATE_STRUCTURE' | 'DELETE_STATISTICS';
}

export interface FlashbackStatement extends ASTNode {
  type: 'FlashbackStatement';
  /** DATABASE | TABLE. */
  target: 'DATABASE' | 'TABLE';
  schema?: string;
  name?: string;
  /** Raw SCN / TIMESTAMP / RESTORE POINT / BEFORE DROP clause. */
  to: string;
}

export interface PurgeStatement extends ASTNode {
  type: 'PurgeStatement';
  /** TABLE | INDEX | RECYCLEBIN | DBA_RECYCLEBIN | TABLESPACE … */
  target: 'RECYCLEBIN' | 'DBA_RECYCLEBIN' | 'TABLE' | 'INDEX' | 'TABLESPACE' | 'USER';
  schema?: string;
  name?: string;
}

export interface CreatePfileSpfileStatement extends ASTNode {
  type: 'CreatePfileSpfileStatement';
  /** What we're writing — PFILE or SPFILE. */
  target: 'PFILE' | 'SPFILE';
  /** Explicit output path; absent means the default $ORACLE_HOME/dbs/… location. */
  outputPath?: string;
  /** Where the parameters come from. MEMORY=current running values. */
  source: 'PFILE' | 'SPFILE' | 'MEMORY';
  /** Explicit source path when source=PFILE|SPFILE. */
  sourcePath?: string;
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

// ── Profile management ──────────────────────────────────────────────

export interface CreateProfileStatement extends ASTNode {
  type: 'CreateProfileStatement';
  profileName: string;
  limits: Map<string, string>;
}

export interface AlterProfileStatement extends ASTNode {
  type: 'AlterProfileStatement';
  profileName: string;
  limits: Map<string, string>;
}

export interface DropProfileStatement extends ASTNode {
  type: 'DropProfileStatement';
  profileName: string;
  cascade?: boolean;
}

// ── AUDIT / NOAUDIT ──────────────────────────────────────────────────

export interface AuditObjectTarget {
  schema?: string;
  name: string;
}

export interface AuditStatement extends ASTNode {
  type: 'AuditStatement';
  /** First option — kept for backward compatibility. */
  auditOption: string;
  /** All comma-separated options (e.g. AUDIT SELECT, UPDATE ON t). */
  auditOptions?: string[];
  /** Present for object-level auditing: AUDIT ... ON [schema.]object. */
  onObject?: AuditObjectTarget;
  byUser?: string;
  byMode?: 'ACCESS' | 'SESSION';
  whenever?: 'SUCCESSFUL' | 'NOT SUCCESSFUL';
}

export interface NoauditStatement extends ASTNode {
  type: 'NoauditStatement';
  auditOption: string;
  auditOptions?: string[];
  onObject?: AuditObjectTarget;
  byUser?: string;
}

/**
 * `COMMENT ON {TABLE|COLUMN|MATERIALIZED VIEW} <name> IS '<text>'`.
 * The catalog stores the text so DBA_TAB_COMMENTS / DBA_COL_COMMENTS
 * can surface it. Real Oracle treats this as a DDL statement with its
 * own action_name in the audit trail.
 */
export interface CommentStatement extends ASTNode {
  type: 'CommentStatement';
  target: 'TABLE' | 'COLUMN' | 'MATERIALIZED_VIEW';
  schema?: string;
  tableName: string;
  /** Set only when target === 'COLUMN'. */
  columnName?: string;
  text: string;
}

/**
 * `ADMINISTER KEY MANAGEMENT …` — TDE wallet & master-key administration.
 * The statement is dispatched on `operation`; the rest of the clause
 * (location, identifier, tag, etc.) is captured for the executor.
 */
export interface AdministerKeyManagementStatement extends ASTNode {
  type: 'AdministerKeyManagementStatement';
  operation:
    | 'CREATE_KEYSTORE'
    | 'OPEN_KEYSTORE'
    | 'CLOSE_KEYSTORE'
    | 'SET_KEY'
    | 'CREATE_AUTO_LOGIN_KEYSTORE'
    | 'BACKUP_KEYSTORE'
    | 'MERGE_KEYSTORE'
    | 'EXPORT_KEYS'
    | 'IMPORT_KEYS';
  /** Filesystem location for the keystore (CREATE / BACKUP / AUTO_LOGIN). */
  location?: string;
  /** Optional keystore backup destination. */
  toLocation?: string;
  /** Wallet/keystore password (from `IDENTIFIED BY "…"`). */
  password?: string;
  /** Tag used in SET KEY USING TAG '…'. */
  tag?: string;
  /** Backup identifier when BACKUP KEYSTORE USING '<id>'. */
  backupId?: string;
  /** TRUE when the statement carries WITH BACKUP. */
  withBackup?: boolean;
}

/**
 * `CREATE AUDIT POLICY <name> [ACTIONS …] [ON [schema.]obj] [ROLES …]`.
 * The unified-audit definition is registered in the catalog; rows
 * surface in `AUDIT_UNIFIED_POLICIES`.
 */
export interface CreateAuditPolicyStatement extends ASTNode {
  type: 'CreateAuditPolicyStatement';
  name: string;
  /** ACTIONS list — verbs such as LOGON, LOGOFF, UPDATE, DELETE. */
  actions: string[];
  /** Optional ON [schema.]object qualifier scoping the actions. */
  onObject?: AuditObjectTarget;
  /** Optional ROLES list — roles whose member sessions trigger the policy. */
  roles?: string[];
}

export interface DropAuditPolicyStatement extends ASTNode {
  type: 'DropAuditPolicyStatement';
  name: string;
}

/**
 * `AUDIT POLICY <name> [BY user[, …]] [EXCEPT user[, …]]` — enables
 * a previously-created unified-audit policy for one or more users.
 */
export interface AuditPolicyStatement extends ASTNode {
  type: 'AuditPolicyStatement';
  policyName: string;
  byUsers?: string[];
  exceptUsers?: string[];
  /** `NOAUDIT POLICY` rather than `AUDIT POLICY`. */
  disable?: boolean;
}

/**
 * `LOCK TABLE [schema.]table IN <mode> MODE [NOWAIT]` — explicit DML
 * lock acquisition. Modes follow the six Oracle TM lock modes.
 */
export interface LockTableStatement extends ASTNode {
  type: 'LockTableStatement';
  schema?: string;
  table: string;
  lockMode: 'ROW SHARE' | 'ROW EXCLUSIVE' | 'SHARE UPDATE' | 'SHARE' | 'SHARE ROW EXCLUSIVE' | 'EXCLUSIVE';
  nowait: boolean;
}

/** `CREATE FLASHBACK ARCHIVE [DEFAULT] name TABLESPACE ts [QUOTA n M] RETENTION n {DAY|MONTH|YEAR}`. */
export interface CreateFlashbackArchiveStatement extends ASTNode {
  type: 'CreateFlashbackArchiveStatement';
  name: string;
  isDefault: boolean;
  tablespace: string;
  quotaMb: number | null;
  retentionDays: number;
}

/** `DROP FLASHBACK ARCHIVE name`. */
export interface DropFlashbackArchiveStatement extends ASTNode {
  type: 'DropFlashbackArchiveStatement';
  name: string;
}

/** `{CREATE|DROP|ALTER} PLUGGABLE DATABASE name [OPEN [READ {ONLY|WRITE}] | CLOSE | …]`. */
export interface PluggableDatabaseStatement extends ASTNode {
  type: 'PluggableDatabaseStatement';
  operation: 'CREATE' | 'DROP' | 'ALTER';
  name: string;
  openMode?: 'READ ONLY' | 'READ WRITE';
  close?: boolean;
}

export interface TypeAttribute {
  name: string;
  typeName: string;
  precision?: number;
  scale?: number;
}

/**
 * `CREATE [OR REPLACE] TYPE [schema.]name AS {OBJECT (attrs) | VARRAY(n) OF t | TABLE OF t}`.
 */
export interface CreateTypeStatement extends ASTNode {
  type: 'CreateTypeStatement';
  schema?: string;
  name: string;
  form: 'object' | 'collection';
  attributes?: TypeAttribute[];
  finalType?: boolean;
  collKind?: 'VARRAY' | 'TABLE';
  upperBound?: number | null;
  elemType?: string;
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
  | CreateTablespaceStatement | DropTablespaceStatement | AlterTablespaceStatement
  | CreatePfileSpfileStatement | AnalyzeStatement
  | FlashbackStatement | PurgeStatement
  | CreateDiskgroupStatement | DropDiskgroupStatement | AlterDiskgroupStatement
  // Explain
  | ExplainPlanStatement
  // Triggers
  | CreateTriggerStatement | DropTriggerStatement
  // Synonyms
  | CreateSynonymStatement | DropSynonymStatement
  // Alter
  | AlterSequenceStatement | AlterIndexStatement
  // Profile
  | CreateProfileStatement | AlterProfileStatement | DropProfileStatement
  // Audit
  | AuditStatement | NoauditStatement
  | CreateAuditPolicyStatement | DropAuditPolicyStatement | AuditPolicyStatement
  | AdministerKeyManagementStatement
  | LockTableStatement
  | CreateFlashbackArchiveStatement | DropFlashbackArchiveStatement
  | PluggableDatabaseStatement
  | CreateTypeStatement
  | CommentStatement
  // PL/SQL
  | PLSQLBlock;

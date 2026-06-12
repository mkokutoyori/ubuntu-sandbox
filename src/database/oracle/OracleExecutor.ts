/**
 * OracleExecutor — Executes parsed SQL statements against Oracle storage.
 *
 * Handles SELECT, INSERT, UPDATE, DELETE, DDL, DCL, and admin commands.
 */

import { BaseExecutor, type ExecutionContext } from '../engine/executor/BaseExecutor';
import { ScalarFunctionEvaluator } from './functions/ScalarFunctionEvaluator';
import { type ResultSet, emptyResult, queryResult, type ColumnMeta, type Row } from '../engine/executor/ResultSet';
import type { Statement, SelectStatement, InsertStatement, UpdateStatement, DeleteStatement,
  CreateTableStatement, DropTableStatement, TruncateTableStatement, AlterTableStatement,
  CreateIndexStatement, DropIndexStatement, CreateSequenceStatement, DropSequenceStatement,
  CreateViewStatement, DropViewStatement,
  CommitStatement, RollbackStatement,
  MergeStatement, WithClause, ConnectByClause, ExplainPlanStatement, CreateTriggerStatement, DropTriggerStatement,
  Expression, IdentifierExpr, LiteralExpr, BinaryExpr, UnaryExpr, FunctionCallExpr,
  StarExpr, IsNullExpr, BetweenExpr, InExpr, LikeExpr, CaseExpr, SelectItem, SubqueryExpr,
  OrderByItem,
  CreateSynonymStatement, DropSynonymStatement, AlterSequenceStatement, AlterIndexStatement,
} from '../engine/parser/ASTNode';
import type { OracleStorage } from './OracleStorage';
import type { OracleCatalog } from './OracleCatalog';
import type { OracleInstance } from './OracleInstance';
import { type CellValue, type StorageRow, type ColumnMeta as StorageColMeta, type ConstraintMeta, type TableMeta } from '../engine/storage/BaseStorage';
import { parseOracleType } from '../engine/catalog/DataType';
import { OracleError } from '../engine/types/DatabaseError';
import { makeSqlId } from './views/sqlId';
import { TransactionManager } from './transaction/TransactionManager';
import { PrivilegeEnforcer } from './security/PrivilegeEnforcer';
import { compareValues as compareOracleValues } from './functions/valueUtils';
import { resolveWindowFunction, type WindowPartition } from './functions/windowFunctions';
import { ConstraintValidator } from './constraints/ConstraintValidator';
import { UserAdminExecutor } from './executor/UserAdminExecutor';
import { SecurityDclExecutor } from './executor/SecurityDclExecutor';
import { InstanceAdminExecutor } from './executor/InstanceAdminExecutor';

/**
 * Statement types Oracle classifies as DDL (SQL Language Reference,
 * "Types of SQL Statements"): CREATE/ALTER/DROP/TRUNCATE plus GRANT,
 * REVOKE, AUDIT, NOAUDIT, COMMENT, ANALYZE, FLASHBACK, PURGE. Each one
 * issues an implicit COMMIT before and after execution. Deliberately
 * excluded: ALTER SYSTEM (system control), ALTER SESSION (session
 * control), STARTUP/SHUTDOWN, LOCK TABLE and all TCL — none of those
 * end the current transaction in real Oracle.
 */
const DDL_STATEMENT_TYPES: ReadonlySet<string> = new Set([
  'CreateTableStatement', 'DropTableStatement', 'AlterTableStatement',
  'TruncateTableStatement',
  'CreateIndexStatement', 'DropIndexStatement', 'AlterIndexStatement',
  'CreateSequenceStatement', 'DropSequenceStatement', 'AlterSequenceStatement',
  'CreateViewStatement', 'DropViewStatement',
  'CreateMaterializedViewStatement', 'DropMaterializedViewStatement',
  'GrantStatement', 'RevokeStatement',
  'CreateUserStatement', 'AlterUserStatement', 'DropUserStatement',
  'CreateRoleStatement', 'DropRoleStatement',
  'CreateTriggerStatement', 'DropTriggerStatement',
  'CreateSynonymStatement', 'DropSynonymStatement',
  'CreateTablespaceStatement', 'DropTablespaceStatement', 'AlterTablespaceStatement',
  'CreateDiskgroupStatement', 'DropDiskgroupStatement', 'AlterDiskgroupStatement',
  'CreateProfileStatement', 'AlterProfileStatement', 'DropProfileStatement',
  'CreateDbLinkStatement', 'DropDbLinkStatement',
  'CreateTypeStatement', 'AlterCompileStatement',
  'CreateFlashbackArchiveStatement', 'DropFlashbackArchiveStatement',
  'CreateAuditPolicyStatement', 'DropAuditPolicyStatement', 'AuditPolicyStatement',
  'AuditStatement', 'NoauditStatement',
  'CommentStatement', 'AnalyzeStatement',
  'FlashbackStatement', 'PurgeStatement',
  'AlterDatabaseStatement', 'PluggableDatabaseStatement',
]);

export class OracleExecutor extends BaseExecutor {
  private instance: OracleInstance;
  /** Scalar SQL function evaluation, extracted to its own module (SRP).
   *  The host closures keep the executor's helpers private. */
  private readonly scalarFunctions = new ScalarFunctionEvaluator({
    evaluateExpression: (e, r, c) => this.evaluateExpression(e, r, c),
    compareValues: (a, b) => this.compareValues(a, b),
    formatOracleDate: (d, f) => this.formatOracleDate(d, f),
    parseOracleDate: (s, f) => this.parseOracleDate(s, f),
    getMetadataDDL: (a) => this.getMetadataDDL(a),
    getContext: () => this.context,
    callStoredFunction: (n, a) =>
      this.commandHost ? this.commandHost.execScalarFunctionCall(this, n, a) : { handled: false, value: null },
  });
  private _currentRowNum: number = 0;
  /** Implicit-transaction lifecycle (undo snapshots, savepoints, tx ids). */
  private readonly txn: TransactionManager;
  /** Centralized ORA-01031/00942/01917/01934 privilege decision rules. */
  private readonly privileges: PrivilegeEnforcer;
  /** Row-level integrity enforcement (NOT NULL, PK/UNIQUE, FK, CHECK, types). */
  private readonly constraints: ConstraintValidator;
  /** Last NEXTVAL obtained per sequence IN THIS SESSION. CURRVAL is a
   *  session-scoped value in Oracle: another session's NEXTVAL must not
   *  change what this session sees. */
  private _sessionCurrval: Map<string, number> = new Map();

  /** SQL*Plus / database session id (set by SQLPlusSession). */
  private _sessionId: string = '0';
  /** Delegate for SQL commands whose effect lives in OracleDatabase
   *  (manager-backed DDL: LOCK TABLE, flashback archive, in-memory, …). */
  private commandHost: import('./SqlCommandHost').SqlCommandHost | null = null;
  /** User/role/profile DCL handlers (extracted from this class — O7). */
  private readonly userAdmin: UserAdminExecutor;
  /** GRANT/REVOKE/AUDIT/TDE/COMMENT handlers (extracted — O7). */
  private readonly securityDcl: SecurityDclExecutor;
  /** Instance/tablespace/ASM administration handlers (extracted — O7). */
  private readonly instanceAdmin: InstanceAdminExecutor;

  constructor(
    storage: OracleStorage,
    catalog: OracleCatalog,
    instance: OracleInstance,
    context: ExecutionContext
  ) {
    super(storage, catalog, context);
    this.instance = instance;
    this.privileges = new PrivilegeEnforcer(catalog, context);
    this.constraints = new ConstraintValidator(storage,
      // CHECK semantics: a row violates only when the predicate is FALSE
      // — UNKNOWN (NULL operands) passes, per the SQL standard / Oracle.
      (cond, row, columns) => this.evaluateCondition3VL(cond, row, columns) !== false);
    this.txn = new TransactionManager(storage, {
      onBegin: txId => this.emitTxnStarted(txId),
      onCommit: (txId, durationMs) => {
        // Every commit advances the database SCN (V$DATABASE.CURRENT_SCN).
        instance.advanceScn();
        this.emitTxnCommitted(txId, durationMs);
      },
      onRollback: txId => this.emitTxnRolledBack(txId),
    });
    this.userAdmin = new UserAdminExecutor({
      storage, catalog, instance, context,
      privileges: this.privileges,
      getSessionId: () => parseInt(this._sessionId, 10) || 0,
    });
    this.securityDcl = new SecurityDclExecutor({
      storage, catalog, context, privileges: this.privileges,
    });
    this.instanceAdmin = new InstanceAdminExecutor({
      storage, catalog, instance, privileges: this.privileges,
    });
  }

  /** Bind this executor to a session id for the oracle.session.* / tx events. */
  setSessionId(sessionId: string): void { this._sessionId = sessionId; }

  /** Inject the OracleDatabase delegate for manager-backed SQL commands. */
  setCommandHost(host: import('./SqlCommandHost').SqlCommandHost): void { this.commandHost = host; }

  private requireCommandHost(): import('./SqlCommandHost').SqlCommandHost {
    if (!this.commandHost) throw new OracleError(900, 'command host not configured');
    return this.commandHost;
  }

  private get bus() { return this.instance.getBus(); }
  private get deviceId() { return this.instance.getDeviceId(); }
  private get sid() { return this.instance.config.sid; }
  private ref() { return { deviceId: this.deviceId, sid: this.sid, sessionId: this._sessionId }; }

  private emitDml(stmt: Statement, rowsAffected: number): void {
    const kind = stmt.type;
    let table = '';
    let tableSchema = this.context.currentSchema;
    if (kind === 'InsertStatement' || kind === 'UpdateStatement' || kind === 'DeleteStatement') {
      const s = stmt as unknown as { table?: { name?: string; schema?: string }; tableName?: string };
      table = s.table?.name ?? s.tableName ?? '';
      tableSchema = s.table?.schema ?? tableSchema;
    }
    // Materialized views reading this table are no longer fresh.
    if (table && rowsAffected > 0) {
      this.catalog.markMaterializedViewsStale(tableSchema, table);
    }
    this.bus.publish({
      topic: 'oracle.dml.executed',
      payload: {
        ...this.ref(),
        schema: this.context.currentSchema,
        table,
        rowsAffected,
      },
    });
  }

  private emitDdl(kind: string, name: string): void {
    this.bus.publish({
      topic: 'oracle.ddl.executed',
      payload: { ...this.ref(), schema: this.context.currentSchema, kind, name },
    });
  }

  private emitTxnStarted(txId: number): void {
    this.bus.publish({
      topic: 'oracle.transaction.started',
      payload: { ...this.ref(), txId },
    });
  }

  private emitTxnCommitted(txId: number, durationMs: number): void {
    this.bus.publish({
      topic: 'oracle.transaction.committed',
      payload: { ...this.ref(), txId, durationMs },
    });
  }

  private emitTxnRolledBack(txId: number): void {
    this.bus.publish({
      topic: 'oracle.transaction.rolled-back',
      payload: { ...this.ref(), txId },
    });
  }

  private emitError(code: number, message: string): void {
    this.bus.publish({
      topic: 'oracle.error.raised',
      payload: { ...this.ref(), code, message },
    });
  }

  execute(statement: Statement): ResultSet {
    const parseStart = performance.now();
    this.emitSqlParsed(statement);
    const result = this.executeStatement(statement);
    const elapsed = performance.now() - parseStart;
    this.emitSqlExecuted(statement, result, elapsed);
    this.recordAuditForStatement(statement, 0);
    this.emitForStatement(statement, result);
    return result;
  }

  private _lastSqlText = '';
  private _lastSqlId = '';

  private emitSqlParsed(statement: Statement): void {
    const text = this.statementText(statement);
    if (!text) return;
    const sqlId = makeSqlId(text);
    this._lastSqlText = text;
    this._lastSqlId = sqlId;
    // Generate an ExecutionPlan now so V$SQL_PLAN / DBMS_XPLAN see it
    // for every parsed statement. Cached by SQL_ID with LRU eviction.
    const db = (this as { _db?: { planGenerator: import('./plan/PlanGenerator').PlanGenerator } })._db;
    if (db) {
      try {
        const plan = db.planGenerator.generate(statement, sqlId, text, this.context.currentSchema);
        this.instance.planCache.put(plan);
        const monitor = (this.instance as unknown as {
          getIndexUsageMonitor?: () => { notePlanUsage: (nodes: ReadonlyArray<{ operation: string; objectName: string | null }>) => void } | null;
        }).getIndexUsageMonitor?.();
        monitor?.notePlanUsage(plan.nodes);
      } catch {
        // PlanGenerator is best-effort. Don't break the actual statement.
      }
    }
    this.bus.publish({
      topic: 'oracle.sql.parsed',
      payload: {
        ...this.ref(),
        sqlId,
        text,
        parsingSchema: this.context.currentSchema,
        hardParse: true,
      },
    });
  }

  /** OracleDatabase injects itself so the executor can reach the
   *  PlanGenerator without a circular import. Optional — when unset
   *  the plan cache stays empty (matches a fresh database). */
  setDatabaseRef(db: { planGenerator: import('./plan/PlanGenerator').PlanGenerator }): void {
    (this as unknown as { _db: typeof db })._db = db;
  }

  private emitSqlExecuted(statement: Statement, result: ResultSet, elapsedMs: number): void {
    if (!this._lastSqlId) return;
    this.bus.publish({
      topic: 'oracle.sql.executed',
      payload: {
        ...this.ref(),
        sqlId: this._lastSqlId,
        elapsedMicros: Math.max(1, Math.round(elapsedMs * 1000)),
        cpuMicros: Math.max(1, Math.round(elapsedMs * 800)),
        bufferGets: result.rows.length + 1,
        diskReads: 0,
        rowsProcessed: result.affectedRows ?? result.rows.length,
      },
    });
  }

  private statementText(stmt: Statement): string {
    const s = stmt as unknown as { sourceText?: string; type: string };
    return s.sourceText ?? stmt.type;
  }

  /** Try to execute, recording errors in audit trail */
  executeWithAudit(statement: Statement): ResultSet {
    try {
      const result = this.executeStatement(statement);
      this.recordAuditForStatement(statement, 0);
      this.emitForStatement(statement, result);
      return result;
    } catch (e: unknown) {
      const code = e instanceof OracleError ? e.code : 600;
      const message = e instanceof Error ? e.message : String(e);
      this.recordAuditForStatement(statement, code);
      this.emitError(code, message);
      throw e;
    }
  }

  /** Post-dispatch reactive emissions (DML rows, DDL kind/name). */
  private emitForStatement(statement: Statement, result: ResultSet): void {
    const t = statement.type;
    if (t === 'InsertStatement' || t === 'UpdateStatement' || t === 'DeleteStatement') {
      this.emitDml(statement, result.affectedRows ?? 0);
      return;
    }
    const ddlKind = this.getActionName(statement);
    if (ddlKind && t !== 'GrantStatement' && t !== 'RevokeStatement'
        && t !== 'AlterSystemStatement' && t !== 'AlterDatabaseStatement') {
      const obj = this.getObjInfo(statement);
      this.emitDdl(ddlKind, obj.name ?? '');
    }
  }

  private recordAuditForStatement(statement: Statement, returncode: number): void {
    const catalog = this.catalog as OracleCatalog;
    const actionName = this.getActionName(statement);

    // Statement-level audit options (AUDIT CREATE TABLE, ...) trigger
    // recording for DML / SELECT too. Honour them by checking the
    // configured options; otherwise we only record DDL/DCL.
    const stmtType = statement.type;
    const dmlMap: Record<string, string> = {
      SelectStatement: 'SELECT',
      InsertStatement: 'INSERT',
      UpdateStatement: 'UPDATE',
      DeleteStatement: 'DELETE',
    };
    const dmlAction = dmlMap[stmtType];
    const audited = dmlAction
      ? catalog.getStmtAuditOpts().some(o => o.auditOption === dmlAction && (o.userName === null || o.userName === this.context.currentSchema))
      : !!actionName;
    if (!audited) {
      // Even when not audited at the statement level, fine-grained
      // audit may still apply to this object.
      if (dmlAction) this.recordFgaForDml(statement, dmlAction as 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE');
      return;
    }

    const objInfo = this.getObjInfo(statement);
    const effectiveAction = actionName ?? dmlAction!;
    const fullSqlText = this._lastSqlText || this.statementText(statement);
    const sqlText = fullSqlText.length > 2000 ? fullSqlText.slice(0, 2000) : fullSqlText;
    const sessionIdNum = parseInt(this._sessionId, 10) || 0;
    catalog.recordAudit({
      sessionId: sessionIdNum,
      username: this.context.currentSchema,
      actionName: effectiveAction,
      objName: objInfo.name,
      objOwner: objInfo.owner,
      returncode,
      privUsed: null,
      sqlText,
      statementType: effectiveAction,
    });
    this.bus.publish({
      topic: 'oracle.audit.recorded',
      payload: {
        deviceId: this.deviceId,
        sid: this.sid,
        sessionId: sessionIdNum,
        username: this.context.currentSchema,
        actionName: effectiveAction,
        objName: objInfo.name ?? null,
        objOwner: objInfo.owner ?? null,
        returncode,
        sqlText,
        timestamp: new Date(),
        osUsername: 'oracle',
        userhost: 'localhost',
        terminal: 'pts/0',
      },
    });
    if (dmlAction) {
      this.recordFgaForDml(statement, dmlAction as 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE');
    }
  }

  /** Apply matching FGA policies against a DML/SELECT statement. */
  private recordFgaForDml(statement: Statement, action: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'): void {
    const catalog = this.catalog as OracleCatalog;
    const policies = catalog.getFgaPolicies();
    if (policies.length === 0) return;
    const obj = this.getObjInfo(statement);
    if (!obj.name) return;
    const matched = catalog.matchFgaPolicies(obj.owner ?? this.context.currentSchema, obj.name, action);
    for (const p of matched) {
      catalog.recordFgaAudit({
        sessionId: parseInt(this._sessionId, 10) || 0,
        timestamp: new Date(),
        dbUser: this.context.currentSchema,
        osUser: 'oracle',
        objectSchema: p.objectSchema,
        objectName: p.objectName,
        policyName: p.policyName,
        sqlText: this._lastSqlText || this.statementText(statement),
        statementType: action,
      });
    }
  }

  private getActionName(stmt: Statement): string | null {
    const map: Record<string, string> = {
      CreateTableStatement: 'CREATE TABLE',
      DropTableStatement: 'DROP TABLE',
      AlterTableStatement: 'ALTER TABLE',
      TruncateTableStatement: 'TRUNCATE TABLE',
      CreateIndexStatement: 'CREATE INDEX',
      DropIndexStatement: 'DROP INDEX',
      CreateSequenceStatement: 'CREATE SEQUENCE',
      DropSequenceStatement: 'DROP SEQUENCE',
      CreateViewStatement: 'CREATE VIEW',
      DropViewStatement: 'DROP VIEW',
      GrantStatement: 'GRANT',
      RevokeStatement: 'REVOKE',
      CreateUserStatement: 'CREATE USER',
      AlterUserStatement: 'ALTER USER',
      DropUserStatement: 'DROP USER',
      CreateRoleStatement: 'CREATE ROLE',
      DropRoleStatement: 'DROP ROLE',
      CreateTriggerStatement: 'CREATE TRIGGER',
      DropTriggerStatement: 'DROP TRIGGER',
      CreateSynonymStatement: 'CREATE SYNONYM',
      DropSynonymStatement: 'DROP SYNONYM',
      CreateTablespaceStatement: 'CREATE TABLESPACE',
      DropTablespaceStatement: 'DROP TABLESPACE',
      AlterTablespaceStatement: 'ALTER TABLESPACE',
      CreateDiskgroupStatement: 'CREATE DISKGROUP',
      DropDiskgroupStatement: 'DROP DISKGROUP',
      AlterDiskgroupStatement: 'ALTER DISKGROUP',
      AlterSystemStatement: 'ALTER SYSTEM',
      AlterDatabaseStatement: 'ALTER DATABASE',
      CreateProfileStatement: 'CREATE PROFILE',
      AlterProfileStatement: 'ALTER PROFILE',
      DropProfileStatement: 'DROP PROFILE',
    };
    return map[stmt.type] ?? null;
  }

  private getObjInfo(stmt: Statement): { name: string | null; owner: string | null } {
    const s = stmt as Record<string, unknown>;
    let name = (s['tableName'] ?? s['indexName'] ?? s['viewName'] ?? s['sequenceName']
      ?? s['username'] ?? s['roleName'] ?? s['triggerName'] ?? s['synonymName']
      ?? s['objectName'] ?? s['profileName'] ?? s['name'] ?? null) as string | null;
    let owner = (s['objectSchema'] ?? s['schema'] ?? this.context.currentSchema) as string | null;

    // UPDATE/DELETE wrap their target in `table: TableRef`. SELECT uses
    // a `from` array. Reach into those shapes so audit/FGA records the
    // actual object instead of falling back to a synthetic name.
    if (!name && (stmt.type === 'UpdateStatement' || stmt.type === 'DeleteStatement')) {
      const table = s['table'] as { schema?: string; name?: string } | undefined;
      if (table?.name) {
        name = table.name;
        if (table.schema) owner = table.schema;
      }
    }
    if (!name && stmt.type === 'SelectStatement') {
      const from = (s['from'] as Array<{ type: string; schema?: string; name?: string }> | undefined);
      const first = from?.find(t => t.type === 'TableRef');
      if (first?.name) {
        name = first.name;
        if (first.schema) owner = first.schema;
      }
    }
    return { name: name?.toUpperCase() ?? null, owner: owner?.toUpperCase() ?? null };
  }

  private executeStatement(statement: Statement): ResultSet {
    // Oracle wraps every DDL statement in implicit COMMITs: one before
    // execution (it survives even when the DDL itself fails) and one
    // after success (SQL Language Reference, "Types of SQL Statements").
    // System/session control statements (ALTER SYSTEM / ALTER SESSION),
    // STARTUP/SHUTDOWN and TCL never commit.
    const isDdl = DDL_STATEMENT_TYPES.has(statement.type);
    if (isDdl && this.txn.isActive) this.txn.commit();
    const out = this.dispatchStatement(statement);
    if (isDdl && this.txn.isActive) this.txn.commit();
    // SQL*Plus SET AUTOCOMMIT ON: every successful DML commits at once.
    const isDml = statement.type === 'InsertStatement' || statement.type === 'UpdateStatement'
      || statement.type === 'DeleteStatement' || statement.type === 'MergeStatement';
    if (isDml && this.context.autoCommit && this.txn.isActive) this.txn.commit();
    this.invalidateResultCacheForStatement(statement);
    return out;
  }

  private invalidateResultCacheForStatement(stmt: Statement): void {
    const mgr = this.getResultCache();
    if (!mgr) return;
    const t = stmt.type;
    const target = (stmt as unknown as {
      table?: { name?: string; schema?: string } | string;
      tableName?: string; schema?: string;
    });
    let name: string | undefined;
    let schema: string | undefined;
    if (typeof target.table === 'string') name = target.table;
    else if (target.table) { name = target.table.name; schema = target.table.schema; }
    name = name ?? target.tableName;
    schema = schema ?? target.schema ?? this.context.currentSchema;
    if (!name) return;
    if (t === 'InsertStatement' || t === 'UpdateStatement' || t === 'DeleteStatement'
        || t === 'TruncateTableStatement' || t === 'AlterTableStatement'
        || t === 'DropTableStatement') {
      mgr.invalidateByObject(schema, name);
    }
  }

  private dispatchStatement(statement: Statement): ResultSet {
    switch (statement.type) {
      case 'SelectStatement': return this.executeSelect(statement);
      case 'InsertStatement': return this.executeInsert(statement);
      case 'UpdateStatement': return this.executeUpdate(statement);
      case 'DeleteStatement': return this.executeDelete(statement);
      case 'CreateTableStatement': return this.executeCreateTable(statement);
      case 'DropTableStatement': return this.executeDropTable(statement);
      case 'TruncateTableStatement': return this.executeTruncate(statement);
      case 'AlterTableStatement': return this.executeAlterTable(statement);
      case 'CreateIndexStatement': return this.executeCreateIndex(statement);
      case 'DropIndexStatement': return this.executeDropIndex(statement);
      case 'CreateSequenceStatement': return this.executeCreateSequence(statement);
      case 'DropSequenceStatement': return this.executeDropSequence(statement);
      case 'CreateViewStatement': return this.executeCreateView(statement);
      case 'DropViewStatement': return this.executeDropView(statement);
      case 'GrantStatement': return this.securityDcl.executeGrant(statement);
      case 'RevokeStatement': return this.securityDcl.executeRevoke(statement);
      case 'CreateUserStatement': return this.userAdmin.executeCreateUser(statement);
      case 'AlterUserStatement': return this.userAdmin.executeAlterUser(statement);
      case 'DropUserStatement': return this.userAdmin.executeDropUser(statement);
      case 'CreateRoleStatement': return this.userAdmin.executeCreateRole(statement);
      case 'DropRoleStatement': return this.userAdmin.executeDropRole(statement);
      case 'CommitStatement': return this.executeCommit();
      case 'RollbackStatement': return this.executeRollback(statement.savepoint);
      case 'SavepointStatement': return this.executeSavepoint(statement.name);
      case 'SetTransactionStatement':
        // The simulator does not differentiate transaction isolation
        // levels — accept silently like a real ROLE / CONSTRAINTS toggle.
        return emptyResult('Transaction set.');
      case 'StartupStatement': return this.instanceAdmin.executeStartup(statement);
      case 'ShutdownStatement': return this.instanceAdmin.executeShutdown(statement);
      case 'AlterSystemStatement': return this.instanceAdmin.executeAlterSystem(statement);
      case 'AlterDatabaseStatement': return this.instanceAdmin.executeAlterDatabase(statement);
      case 'CreateTablespaceStatement': return this.instanceAdmin.executeCreateTablespace(statement);
      case 'DropTablespaceStatement': return this.instanceAdmin.executeDropTablespace(statement);
      case 'AlterTablespaceStatement': return this.instanceAdmin.executeAlterTablespace(statement);
      case 'AnalyzeStatement': {
        const s = statement as import('../engine/parser/ASTNode').AnalyzeStatement;
        const schema = this.resolveSchema(s.schema);
        const name = s.name.toUpperCase();
        if (s.target === 'TABLE') {
          if (!this.storage.tableExists(schema, name)) {
            throw new OracleError(942, `table or view does not exist`);
          }
          if (s.action === 'COMPUTE_STATISTICS' || s.action === 'ESTIMATE_STATISTICS') {
            // Stamp the table with a real LAST_ANALYZED timestamp.
            const meta = this.storage.getTableMeta(schema, name)!;
            meta.lastAnalyzed = new Date();
          } else if (s.action === 'DELETE_STATISTICS') {
            const meta = this.storage.getTableMeta(schema, name)!;
            meta.lastAnalyzed = null;
          }
        }
        return emptyResult(`${s.target === 'TABLE' ? 'Table' : s.target === 'INDEX' ? 'Index' : 'Cluster'} analyzed.`);
      }
      case 'FlashbackStatement': {
        const s = statement as import('../engine/parser/ASTNode').FlashbackStatement;
        // Only FLASHBACK TABLE … TO BEFORE DROP is plumbed against
        // real state (the recyclebin). DATABASE / TO TIMESTAMP / SCN
        // are accepted but logical no-ops — the simulator has no
        // undo/redo time machine.
        if (s.target === 'TABLE' && /BEFORE\s+DROP/i.test(s.to)) {
          const owner = this.resolveSchema(s.schema);
          const name = s.name!.toUpperCase();
          const catalog = this.catalog as OracleCatalog;
          const entry = catalog.recyclebinFindLatest(owner, name);
          if (!entry || !entry.payload) {
            throw new OracleError(38305, `object not in RECYCLE BIN`);
          }
          const payload = entry.payload as { meta: import('../engine/storage/BaseStorage').TableMeta; rows: StorageRow[] };
          this.storage.ensureSchema(owner);
          this.storage.createTable({
            ...payload.meta, schema: owner, name, rowCount: payload.rows.length,
          });
          this.storage.insertRows(owner, name, payload.rows);
          catalog.recyclebinRemove(entry.objectName);
        }
        this.instance.logAlert(`FLASHBACK ${s.target}${s.name ? ' ' + (s.schema ? s.schema + '.' : '') + s.name : ''} ${s.to}`);
        return emptyResult(`Flashback complete.`);
      }
      case 'PurgeStatement': {
        const s = statement as import('../engine/parser/ASTNode').PurgeStatement;
        const catalog = this.catalog as OracleCatalog;
        if (s.target === 'RECYCLEBIN' || s.target === 'USER') {
          catalog.recyclebinPurgeAll(this.context.currentSchema);
        } else if (s.target === 'DBA_RECYCLEBIN') {
          catalog.recyclebinPurgeAll();
        } else if (s.target === 'TABLE' && s.name) {
          // PURGE TABLE name → remove the (most recent) recyclebin
          // entry with that original name.
          const owner = this.resolveSchema(s.schema);
          const entry = catalog.recyclebinFindLatest(owner, s.name.toUpperCase());
          if (entry) catalog.recyclebinRemove(entry.objectName);
        }
        return emptyResult('Recyclebin purged.');
      }
      case 'CreatePfileSpfileStatement': return this.instanceAdmin.executeCreatePfileSpfile(statement);
      case 'CreateDiskgroupStatement': return this.instanceAdmin.executeCreateDiskgroup(statement);
      case 'DropDiskgroupStatement': return this.instanceAdmin.executeDropDiskgroup(statement);
      case 'AlterDiskgroupStatement': return this.instanceAdmin.executeAlterDiskgroup(statement);
      case 'MergeStatement': return this.executeMerge(statement);
      case 'ExplainPlanStatement': return this.executeExplainPlan(statement);
      case 'CreateTriggerStatement': return this.executeCreateTrigger(statement);
      case 'DropTriggerStatement': return this.executeDropTrigger(statement);
      case 'CreateSynonymStatement': return this.executeCreateSynonym(statement);
      case 'DropSynonymStatement': return this.executeDropSynonym(statement);
      case 'AlterSequenceStatement': return this.executeAlterSequence(statement);
      case 'AlterIndexStatement': return this.executeAlterIndex(statement);
      case 'CreateDbLinkStatement': return this.executeCreateDbLink(statement);
      case 'DropDbLinkStatement': return this.executeDropDbLink(statement);
      case 'CreateMaterializedViewStatement': return this.executeCreateMaterializedView(statement);
      case 'DropMaterializedViewStatement': return this.executeDropMaterializedView(statement);
      case 'CreateProfileStatement': return this.userAdmin.executeCreateProfile(statement);
      case 'AlterProfileStatement': return this.userAdmin.executeAlterProfile(statement);
      case 'DropProfileStatement': return this.userAdmin.executeDropProfile(statement);
      case 'AuditStatement': return this.securityDcl.executeAudit(statement);
      case 'NoauditStatement': return this.securityDcl.executeNoaudit(statement);
      case 'CreateAuditPolicyStatement': return this.securityDcl.executeCreateAuditPolicy(statement);
      case 'DropAuditPolicyStatement': return this.securityDcl.executeDropAuditPolicy(statement);
      case 'AuditPolicyStatement': return this.securityDcl.executeAuditPolicy(statement);
      case 'AdministerKeyManagementStatement': return this.securityDcl.executeAdministerKeyManagement(statement);
      case 'LockTableStatement': return this.requireCommandHost().execLockTable(statement, this.context);
      case 'CreateFlashbackArchiveStatement': return this.requireCommandHost().execCreateFlashbackArchive(statement, this.context);
      case 'DropFlashbackArchiveStatement': return this.requireCommandHost().execDropFlashbackArchive(statement, this.context);
      case 'PluggableDatabaseStatement': return this.requireCommandHost().execPluggableDatabase(statement, this.context);
      case 'CreateTypeStatement': return this.requireCommandHost().execCreateType(statement, this.context);
      case 'AlterSessionStatement': return this.requireCommandHost().execAlterSession(statement, this.context);
      case 'AlterCompileStatement': {
        const label = statement.objectKind === 'PROCEDURE' ? 'Procedure'
          : statement.objectKind === 'FUNCTION' ? 'Function' : 'Package';
        return emptyResult(`${label} altered.`);
      }
      case 'CommentStatement': return this.securityDcl.executeComment(statement);
      default:
        throw new OracleError(900, `Unsupported statement type: ${statement.type}`);
    }
  }

  // ── Transaction control ──────────────────────────────────────────

  private executeCommit(): ResultSet {
    this.txn.commit();
    return emptyResult('Commit complete.');
  }

  private executeRollback(savepoint?: string): ResultSet {
    if (savepoint) {
      // Throws ORA-01086 when never established; transaction stays active.
      this.txn.rollbackToSavepoint(savepoint);
      return emptyResult('Rollback complete.');
    }
    this.txn.rollback();
    return emptyResult('Rollback complete.');
  }

  private executeSavepoint(name: string): ResultSet {
    this.txn.createSavepoint(name);
    return emptyResult('Savepoint created.');
  }

  // ── SELECT ────────────────────────────────────────────────────────

  private executeSelect(stmt: SelectStatement): ResultSet {
    const cached = this.tryResultCacheHit(stmt);
    if (cached) return cached;
    const result = this.executeSelectInner(stmt);
    this.maybeStoreInResultCache(stmt, result);
    return result;
  }

  private executeSelectInner(stmt: SelectStatement): ResultSet {
    const outerRowNum = this._currentRowNum;
    try {
      return this.executeSelectBlock(stmt);
    } finally {
      this._currentRowNum = outerRowNum;
    }
  }

  private executeSelectBlock(stmt: SelectStatement): ResultSet {
    // Handle WITH (CTE) clause — materialize CTEs as temporary tables, execute inner SELECT, then clean up
    if (stmt.withClause) {
      return this.executeWithCTE(stmt);
    }

    // Handle set operations (UNION, INTERSECT, MINUS)
    if (stmt.setOp) {
      return this.executeSetOperation(stmt);
    }

    // DUAL has its own minimal pipeline (no JOIN/GROUP BY etc.), but
    // the row-generator idiom `SELECT … FROM DUAL CONNECT BY LEVEL <= N`
    // needs the full hierarchical pipeline.
    if (stmt.from && stmt.from.length === 1 && stmt.from[0].type === 'TableRef'
        && !stmt.connectBy && !stmt.groupBy && !stmt.where) {
      const firstName = stmt.from[0].name.toUpperCase();
      if (firstName === 'DUAL') {
        return this.executeSelectFromDual(stmt);
      }
    }

    // Every other table reference — catalog dictionary views included —
    // flows through `executeSelectFromTable`, which knows about JOIN,
    // GROUP BY, aggregates, HAVING, DISTINCT, ORDER BY, and FETCH.
    // `loadTable` materialises catalog views as virtual row sources so
    // `SELECT COUNT(*) FROM v$log` etc. evaluate correctly.
    return this.executeSelectFromTable(stmt);
  }

  /** Detect the RESULT_CACHE optimizer hint in the original source SQL. */
  private hasResultCacheHint(stmt: SelectStatement): boolean {
    const src = (stmt as unknown as { sourceText?: string }).sourceText ?? '';
    return /\/\*\+[^*]*\bRESULT_CACHE\b/i.test(src);
  }

  /** Hash a SELECT source text + current user into a stable cache key. */
  private resultCacheKey(stmt: SelectStatement): string {
    const src = (stmt as unknown as { sourceText?: string }).sourceText ?? '';
    return `${this.context.currentUser}|${src.replace(/\s+/g, ' ').trim()}`;
  }

  private getResultCache(): import('./resultcache/ResultCache').ResultCacheManager | null {
    return (this.instance as unknown as {
      resultCache?: import('./resultcache/ResultCache').ResultCacheManager;
    }).resultCache ?? null;
  }

  private tryResultCacheHit(stmt: SelectStatement): ResultSet | null {
    if (!this.hasResultCacheHint(stmt)) return null;
    const mgr = this.getResultCache();
    if (!mgr || !mgr.enabled) return null;
    const hit = mgr.lookup(this.resultCacheKey(stmt));
    if (!hit) return null;
    const payload = hit.payload as ResultSet;
    return { ...payload, rows: payload.rows.map((r) => r.slice()) };
  }

  private maybeStoreInResultCache(stmt: SelectStatement, result: ResultSet): void {
    if (!this.hasResultCacheHint(stmt)) return;
    const mgr = this.getResultCache();
    if (!mgr || !mgr.enabled) return;
    const key = this.resultCacheKey(stmt);
    const deps = this.collectFromTableDeps(stmt);
    const name = ((stmt as unknown as { sourceText?: string }).sourceText ?? 'cached')
      .replace(/\s+/g, ' ').trim().slice(0, 120);
    mgr.store(key, result, name, deps, {
      rowCount: result.rows.length,
      columnCount: result.columns.length,
      rowSize: 80, creator: this.context.currentUser,
    });
  }

  private collectFromTableDeps(stmt: SelectStatement): Array<{ owner: string; name: string; type: string }> {
    const out: Array<{ owner: string; name: string; type: string }> = [];
    const visit = (s: SelectStatement): void => {
      for (const f of s.from ?? []) {
        if (f.type === 'TableRef') {
          const owner = this.resolveSchema(f.schema);
          const name = f.name.toUpperCase();
          if (name !== 'DUAL') out.push({ owner, name, type: 'TABLE' });
        } else if (f.type === 'SubqueryTableRef') {
          visit(f.query);
        }
      }
      for (const j of s.joins ?? []) {
        if (j.table.type === 'TableRef') {
          const owner = this.resolveSchema(j.table.schema);
          const name = j.table.name.toUpperCase();
          if (name !== 'DUAL') out.push({ owner, name, type: 'TABLE' });
        }
      }
    };
    visit(stmt);
    return out;
  }

  /** Invalidate all cached results whose dependencies touch (schema, table). */
  invalidateResultCacheFor(schema: string, table: string): void {
    const mgr = this.getResultCache();
    mgr?.invalidateByObject(schema, table);
  }

  /**
   * Apply DBMS_REDACT policies at row-source level when loading a table.
   * Bypassed for SYS / SYSTEM and any user whose name appears in the
   * policy expression's `SESSION_USER NOT IN (…)` exclusion list.
   */
  private maybeRedactRows(
    schema: string, tableName: string,
    cols: StorageColMeta[], rows: StorageRow[],
  ): StorageRow[] {
    if (!rows.length) return rows;
    const user = (this.context.currentUser ?? '').toUpperCase();
    if (user === 'SYS' || user === 'SYSTEM') return rows;
    const redact = (this.instance as unknown as {
      redaction?: import('./security/DataRedactionManager').DataRedactionManager;
    }).redaction;
    if (!redact) return rows;
    const map = redact.findActiveRedactions(schema, tableName, user);
    if (map.size === 0) return rows;
    const indexed: Array<{ i: number; action: import('./security/DataRedactionManager').RedactionColumn } | null> =
      cols.map((c, i) => {
        const a = map.get(c.name.toUpperCase());
        return a ? { i, action: a } : null;
      });
    if (!indexed.some(Boolean)) return rows;
    return rows.map((row) => {
      const next = row.slice();
      for (const e of indexed) {
        if (!e) continue;
        next[e.i] = redact.applyRedaction(next[e.i], e.action) as StorageRow[number];
      }
      return next;
    });
  }

  // ── WITH / CTE ──────────────────────────────────────────────────

  private executeWithCTE(stmt: SelectStatement): ResultSet {
    const cteSchema = '__CTE__';
    const cteNames: string[] = [];

    try {
      // Materialize each CTE as a temporary table
      for (const cte of stmt.withClause!.ctes) {
        const cteName = cte.name.toUpperCase();

        // Patch CTE inner query to reference already-materialized CTEs
        const patchedQuery = cteNames.length > 0
          ? this.patchCTERefs({ ...cte.query, type: 'Select' } as SelectStatement, cteNames, cteSchema)
          : cte.query;

        // Execute the CTE query
        const cteResult = this.executeSelect(patchedQuery);

        cteNames.push(cteName);

        // Create a temporary table in a special CTE schema
        const columns: StorageColMeta[] = cteResult.columns.map((col, i) => ({
          name: cte.columns ? cte.columns[i]?.toUpperCase() || col.name : col.name,
          dataType: col.dataType,
          ordinalPosition: i,
        }));

        this.storage.createTable({
          schema: cteSchema, name: cteName, columns, constraints: [],
          tablespace: 'SYSTEM', temporary: true, rowCount: 0,
        });
        for (const row of cteResult.rows) {
          this.storage.insertRow(cteSchema, cteName, row as StorageRow);
        }
      }

      // Execute the main SELECT with CTEs available. Temporarily make CTE tables
      // visible by patching FROM references to use the CTE schema.
      const patchedStmt = this.patchCTERefs(stmt, cteNames, cteSchema);

      return this.executeSelect({ ...patchedStmt, withClause: undefined });
    } finally {
      // Clean up CTE tables
      for (const cteName of cteNames) {
        try { this.storage.dropTable(cteSchema, cteName); } catch { /* ignore */ }
      }
    }
  }

  private patchCTERefs(stmt: SelectStatement, cteNames: string[], cteSchema: string): SelectStatement {
    const patched = { ...stmt };

    // Patch FROM references
    if (patched.from) {
      patched.from = patched.from.map(ref => {
        if (ref.type === 'TableRef' && cteNames.includes(ref.name.toUpperCase()) && !ref.schema) {
          return { ...ref, schema: cteSchema };
        }
        return ref;
      });
    }

    // Patch JOIN references
    if (patched.joins) {
      patched.joins = patched.joins.map(join => {
        if (join.table.type === 'TableRef' && cteNames.includes(join.table.name.toUpperCase()) && !join.table.schema) {
          return { ...join, table: { ...join.table, schema: cteSchema } };
        }
        return join;
      });
    }

    return patched;
  }

  private executeSelectFromDual(stmt: SelectStatement): ResultSet {
    const columns: ColumnMeta[] = [];
    const row: CellValue[] = [];

    for (const item of stmt.columns) {
      const colName = item.alias || this.exprToString(item.expr);
      const value = this.evaluateExpression(item.expr, [], []);
      columns.push({ name: colName, dataType: parseOracleType('VARCHAR2', 4000) });
      row.push(value);
    }

    return queryResult(columns, [row]);
  }

  private executeSelectFromTable(stmt: SelectStatement): ResultSet {
    if (!stmt.from || stmt.from.length === 0) {
      return this.executeSelectFromDual(stmt);
    }

    // ── Step 1: Build combined row set (FROM + JOINs) ──────────────
    const fromResult = this.resolveFromClause(stmt);
    let rows = fromResult.rows;
    const columns = fromResult.columns;

    // ── Step 2: WHERE filter ───────────────────────────────────────
    if (stmt.where) {
      const filtered: StorageRow[] = [];
      for (const row of rows) {
        this._currentRowNum = filtered.length + 1;
        if (this.evaluateCondition(stmt.where!, row, columns)) {
          filtered.push(row);
        }
      }
      rows = filtered;
    }

    // ── Step 2b: CONNECT BY (hierarchical query) ─────────────────
    if (stmt.connectBy) {
      rows = this.executeConnectBy(rows, columns, stmt.connectBy);
    }

    // ── Step 3: GROUP BY + aggregation ─────────────────────────────
    const hasAggregates = this.selectHasAggregates(stmt.columns);
    if (stmt.groupBy || hasAggregates) {
      // ORA-00979: validate that non-aggregate SELECT items are in GROUP BY
      this.validateGroupByExpressions(stmt, columns);
      const grouped = this.performGroupBy(rows, columns, stmt);
      // HAVING filter on groups
      if (stmt.having) {
        const filteredGroups: { key: CellValue[]; rows: StorageRow[] }[] = [];
        for (const group of grouped) {
          if (this.evaluateConditionAggregate(stmt.having, group.rows, columns)) {
            filteredGroups.push(group);
          }
        }
        return this.projectGroupedRows(filteredGroups, columns, stmt);
      }
      return this.projectGroupedRows(grouped, columns, stmt);
    }

    // ── Step 4: SELECT columns (with window function support) ─────
    const selectCols = this.expandSelectItems(stmt.columns, columns);
    const resultColumns: ColumnMeta[] = selectCols.map(col => ({ name: col.alias || col.name, dataType: col.dataType }));

    // Check for window functions
    const windowColIndices: number[] = [];
    for (let i = 0; i < stmt.columns.length; i++) {
      if (stmt.columns[i].expr.type === 'FunctionCall' && stmt.columns[i].expr.over) {
        windowColIndices.push(i);
      }
    }

    let resultRows: Row[] = rows.map((row, rowIndex) => {
      this._currentRowNum = rowIndex + 1;
      return selectCols.map(col => {
        if (col.colIndex >= 0) return row[col.colIndex];
        if (col.expr) {
          // Skip window function evaluation here — handled below
          if (col.expr.type === 'FunctionCall' && (col.expr as FunctionCallExpr).over) return null;
          return this.evaluateExpression(col.expr, row, columns);
        }
        return null;
      });
    });

    // ── Step 4b: Evaluate window functions ────────────────────────
    if (windowColIndices.length > 0) {
      this.evaluateWindowFunctions(resultRows, rows, columns, stmt.columns, windowColIndices);
    }

    // ── Step 5: DISTINCT ───────────────────────────────────────────
    if (stmt.distinct) {
      const seen = new Set<string>();
      resultRows = resultRows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // ── Step 6: ORDER BY ───────────────────────────────────────────
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      // ORA-01791: DISTINCT requires ORDER BY expressions to be in SELECT list
      if (stmt.distinct) {
        for (const ob of stmt.orderBy) {
          const idx = this.resolveOrderByIndex(ob.expr, selectCols, columns);
          if (idx < 0) {
            throw new OracleError(1791, 'not a SELECTed expression');
          }
        }
      }
      resultRows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          // Try to resolve by column alias or position in result set
          const idx = this.resolveOrderByIndex(ob.expr, selectCols, columns);
          if (idx < 0) continue;
          const cmp = this.compareWithOrderSpec(a[idx], b[idx], ob);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    // ── Step 7: FETCH/OFFSET ───────────────────────────────────────
    if (stmt.fetch) {
      let offset = 0;
      if (stmt.fetch.offset) offset = Number(this.evaluateExpression(stmt.fetch.offset, [], []));
      let limit = resultRows.length;
      if (stmt.fetch.count) limit = Number(this.evaluateExpression(stmt.fetch.count, [], []));
      resultRows = resultRows.slice(offset, offset + limit);
    }

    return queryResult(resultColumns, resultRows);
  }

  // ── FROM + JOIN resolution ─────────────────────────────────────

  private resolveFromClause(stmt: SelectStatement): { rows: StorageRow[]; columns: StorageColMeta[] } {
    const firstRef = stmt.from![0];
    let { rows, columns } = this.loadTableReference(firstRef);

    // Handle additional FROM references (comma-separated → implicit CROSS JOIN)
    for (let i = 1; i < stmt.from!.length; i++) {
      const right = this.loadTableReference(stmt.from![i]);
      const crossJoin: import('../engine/parser/ASTNode').JoinClause = {
        joinType: 'CROSS',
        table: stmt.from![i],
      };
      const result = this.performJoin(rows, columns, right.rows, right.columns, crossJoin);
      rows = result.rows;
      columns = result.columns;
    }

    // Process JOINs
    if (stmt.joins) {
      for (const join of stmt.joins) {
        const right = this.loadTableReference(join.table);
        const result = this.performJoin(rows, columns, right.rows, right.columns, join);
        rows = result.rows;
        columns = result.columns;
      }
    }

    return { rows, columns };
  }

  private loadTableReference(ref: import('../engine/parser/ASTNode').TableReference): { rows: StorageRow[]; columns: StorageColMeta[] } {
    if (ref.type === 'TableRef') {
      return this.loadTable(ref);
    }
    // SubqueryTableRef — inline view
    const result = this.executeSelect(ref.query);
    const alias = ref.alias?.toUpperCase() || 'SUBQUERY';
    const columns: StorageColMeta[] = result.columns.map((c: ColumnMeta, i: number) => ({
      name: c.name,
      dataType: c.dataType || 'VARCHAR2',
      ordinalPosition: i,
      _qualifiedNames: [c.name, `${alias}.${c.name}`],
    } as StorageColMeta & { _qualifiedNames: string[] }));
    const rows: StorageRow[] = result.rows.map((r: Row) => [...r]);
    return { rows, columns };
  }

  private loadTable(ref: import('../engine/parser/ASTNode').TableRef): { rows: StorageRow[]; columns: StorageColMeta[] } {
    const schema = this.resolveSchema(ref.schema);
    const tableName = ref.name.toUpperCase();
    const alias = ref.alias?.toUpperCase();

    // Check if it's a view first
    const viewMeta = this.storage.getViewMeta(schema, tableName);
    if (viewMeta) {
      return this.loadView(viewMeta, alias || tableName);
    }

    // Catalog dictionary views (DBA_*, ALL_*, USER_*, V$*, GV$*,
    // UNIFIED_AUDIT_TRAIL, SYS.OBJ$, …). They are materialised as
    // virtual row sources here so the rest of the SELECT pipeline
    // (JOIN, GROUP BY, aggregates, HAVING, ORDER BY) can operate on
    // them exactly like a real table.
    const catalogName = ref.schema?.toUpperCase() === 'SYS' ? `SYS.${tableName}` : tableName;
    const catalogResult = (this.catalog as OracleCatalog).queryCatalogView(catalogName, this.context.currentUser);
    if (catalogResult && catalogResult.isQuery) {
      const prefix = alias || tableName;
      const columns: StorageColMeta[] = catalogResult.columns.map((c, i) => ({
        name: c.name,
        dataType: c.dataType,
        ordinalPosition: i,
        _qualifiedNames: [c.name, `${prefix}.${c.name}`],
      } as StorageColMeta & { _qualifiedNames: string[] }));
      const rows: StorageRow[] = catalogResult.rows.map(r => [...r] as StorageRow);
      return { rows, columns };
    }

    const meta = this.requireTableMeta(schema, tableName);
    // Cross-schema read requires SELECT privilege (or SELECT ANY TABLE)
    this.privileges.requireObjectAccess(schema, tableName, 'SELECT');
    const storageRows = this.storage.getRows(schema, tableName);
    const rows = this.maybeRedactRows(schema, tableName, meta.columns, storageRows);

    // Prefix column names with alias or table name for disambiguation
    const prefix = alias || tableName;
    const columns: StorageColMeta[] = meta.columns.map((c, i) => ({
      ...c,
      name: c.name,
      ordinalPosition: i,
      _qualifiedNames: [c.name, `${prefix}.${c.name}`],
    } as StorageColMeta & { _qualifiedNames: string[] }));

    return { rows, columns };
  }

  private loadView(viewMeta: import('../engine/storage/BaseStorage').ViewMeta, prefix: string): { rows: StorageRow[]; columns: StorageColMeta[] } {
    // Execute the stored query AST
    if (!viewMeta.queryAST) {
      throw new OracleError(942, `view ${viewMeta.name} has no query`);
    }
    const result = this.executeSelect(viewMeta.queryAST as SelectStatement);

    // Convert ResultSet rows back to StorageRow format
    const columns: StorageColMeta[] = result.columns.map((c: ColumnMeta, i: number) => {
      const colName = viewMeta.columns?.[i] || c.name;
      return {
        name: colName,
        dataType: c.dataType || 'VARCHAR2',
        ordinalPosition: i,
        _qualifiedNames: [colName, `${prefix}.${colName}`],
      } as StorageColMeta & { _qualifiedNames: string[] };
    });
    const rows: StorageRow[] = result.rows.map((r: Row) => [...r]);

    return { rows, columns };
  }

  private performJoin(
    leftRows: StorageRow[], leftCols: StorageColMeta[],
    rightRows: StorageRow[], rightCols: StorageColMeta[],
    join: import('../engine/parser/ASTNode').JoinClause
  ): { rows: StorageRow[]; columns: StorageColMeta[] } {
    // Determine common columns for USING or NATURAL join
    let usingCols: string[] | undefined = join.using;
    if (join.joinType === 'NATURAL') {
      // NATURAL: find all columns with the same name in both sides
      const leftNames = new Set(leftCols.map(c => c.name.toUpperCase()));
      usingCols = rightCols.map(c => c.name.toUpperCase()).filter(n => leftNames.has(n));
    }

    // For USING / NATURAL: build combined columns with shared columns appearing once
    let combinedCols: StorageColMeta[];
    let rightColIndices: number[]; // indices into rightCols that appear in output
    if (usingCols && usingCols.length > 0) {
      const usingSet = new Set(usingCols.map(c => c.toUpperCase()));
      // Shared columns come from left side only (deduplicated)
      combinedCols = leftCols.map((c, i) => ({ ...c, ordinalPosition: i }));
      // Add right-side columns that are NOT in the USING set
      rightColIndices = [];
      for (let i = 0; i < rightCols.length; i++) {
        if (!usingSet.has(rightCols[i].name.toUpperCase())) {
          rightColIndices.push(i);
          combinedCols.push({ ...rightCols[i], ordinalPosition: combinedCols.length });
        }
      }
    } else {
      combinedCols = [
        ...leftCols.map((c, i) => ({ ...c, ordinalPosition: i })),
        ...rightCols.map((c, i) => ({ ...c, ordinalPosition: leftCols.length + i })),
      ];
      rightColIndices = rightCols.map((_, i) => i);
    }

    const nullRight = new Array(rightColIndices.length).fill(null);
    const nullLeft = new Array(leftCols.length).fill(null);

    // Build effective ON condition for USING/NATURAL
    const onCondition = join.on;
    if (usingCols && usingCols.length > 0 && !onCondition) {
      // Build ON condition: left.col = right.col AND ...
      // We match by column name in the combined row
      const conditions: Array<{ leftIdx: number; rightIdx: number }> = [];
      for (const col of usingCols) {
        const li = leftCols.findIndex(c => c.name.toUpperCase() === col.toUpperCase());
        const ri = rightCols.findIndex(c => c.name.toUpperCase() === col.toUpperCase());
        if (li >= 0 && ri >= 0) conditions.push({ leftIdx: li, rightIdx: ri });
      }
      // Use a custom evaluator for USING/NATURAL instead of AST condition
      const evalUsing = (leftRow: StorageRow, rightRow: StorageRow): boolean => {
        return conditions.every(({ leftIdx, rightIdx }) => {
          const lv = leftRow[leftIdx];
          const rv = rightRow[rightIdx];
          if (lv == null || rv == null) return false;
          return this.compareValues(lv, rv) === 0;
        });
      };

      // Execute join with custom condition
      return this.executeJoinLoop(leftRows, leftCols, rightRows, rightColIndices, combinedCols, nullRight, nullLeft, join.joinType, evalUsing);
    }

    if (join.joinType === 'CROSS') {
      const rows: StorageRow[] = [];
      for (const l of leftRows) {
        for (const r of rightRows) {
          const rightVals = rightColIndices.map(i => r[i]);
          rows.push([...l, ...rightVals]);
        }
      }
      return { rows, columns: combinedCols };
    }

    // Standard ON-based join
    const allRightCols = [...leftCols.map((c, i) => ({ ...c, ordinalPosition: i })), ...rightCols.map((c, i) => ({ ...c, ordinalPosition: leftCols.length + i }))];
    const evalOn = (leftRow: StorageRow, rightRow: StorageRow): boolean => {
      const fullCombined = [...leftRow, ...rightRow];
      return !onCondition || this.evaluateCondition(onCondition, fullCombined, allRightCols);
    };

    return this.executeJoinLoop(leftRows, leftCols, rightRows, rightColIndices, combinedCols, nullRight, nullLeft, join.joinType, evalOn);
  }

  private executeJoinLoop(
    leftRows: StorageRow[], leftCols: StorageColMeta[],
    rightRows: StorageRow[], rightColIndices: number[],
    combinedCols: StorageColMeta[],
    nullRight: null[], nullLeft: null[],
    joinType: string,
    evalCondition: (leftRow: StorageRow, rightRow: StorageRow) => boolean
  ): { rows: StorageRow[]; columns: StorageColMeta[] } {
    const resultRows: StorageRow[] = [];
    const rightMatched = new Set<number>();

    for (let li = 0; li < leftRows.length; li++) {
      let matched = false;
      for (let ri = 0; ri < rightRows.length; ri++) {
        if (evalCondition(leftRows[li], rightRows[ri])) {
          const rightVals = rightColIndices.map(i => rightRows[ri][i]);
          resultRows.push([...leftRows[li], ...rightVals]);
          rightMatched.add(ri);
          matched = true;
        }
      }
      if (!matched && (joinType === 'LEFT' || joinType === 'FULL' || joinType === 'NATURAL')) {
        resultRows.push([...leftRows[li], ...nullRight]);
      }
    }

    if (joinType === 'RIGHT' || joinType === 'FULL') {
      for (let ri = 0; ri < rightRows.length; ri++) {
        if (!rightMatched.has(ri)) {
          const rightVals = rightColIndices.map(i => rightRows[ri][i]);
          resultRows.push([...nullLeft, ...rightVals]);
        }
      }
    }

    return { rows: resultRows, columns: combinedCols };
  }

  // ── GROUP BY + Aggregation ─────────────────────────────────────

  private selectHasAggregates(items: SelectItem[]): boolean {
    return items.some(item => this.exprHasAggregate(item.expr));
  }

  private exprHasAggregate(expr: Expression): boolean {
    if (expr.type === 'FunctionCall') {
      // Window functions (with OVER) are NOT regular aggregates
      if ((expr as FunctionCallExpr).over) return false;
      const name = expr.name.toUpperCase();
      if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'STDDEV', 'VARIANCE', 'LISTAGG'].includes(name)) return true;
    }
    if (expr.type === 'BinaryExpr') {
      return this.exprHasAggregate(expr.left) || this.exprHasAggregate(expr.right);
    }
    if (expr.type === 'UnaryExpr') return this.exprHasAggregate(expr.operand);
    return false;
  }

  private validateGroupByExpressions(stmt: SelectStatement, columns: StorageColMeta[]): void {
    if (!stmt.groupBy || stmt.groupBy.length === 0) return; // Pure aggregate (no GROUP BY) is always valid
    // Collect normalized GROUP BY expression keys
    const groupByKeys = new Set<string>();
    for (const gExpr of stmt.groupBy) {
      groupByKeys.add(this.normalizeExprKey(gExpr));
    }
    // Validate each SELECT item
    for (const item of stmt.columns) {
      if (item.expr.type === 'Star') continue; // SELECT * with GROUP BY is unusual but skip validation
      this.validateExprInGroupBy(item.expr, groupByKeys);
    }
  }

  private validateExprInGroupBy(expr: Expression, groupByKeys: Set<string>): void {
    // If this expression is an aggregate, it's fine
    if (this.exprHasAggregate(expr)) return;
    // If it's a literal, it's fine
    if (expr.type === 'Literal') return;
    // If the whole expression matches a GROUP BY key, it's fine
    if (groupByKeys.has(this.normalizeExprKey(expr))) return;
    // Binary expression: check both sides
    if (expr.type === 'BinaryExpr') {
      this.validateExprInGroupBy(expr.left, groupByKeys);
      this.validateExprInGroupBy(expr.right, groupByKeys);
      return;
    }
    // Function call (non-aggregate): check args
    if (expr.type === 'FunctionCall') {
      for (const arg of expr.args) this.validateExprInGroupBy(arg, groupByKeys);
      return;
    }
    // Paren expression
    if (expr.type === 'ParenExpr') {
      this.validateExprInGroupBy(expr.expr, groupByKeys);
      return;
    }
    // Case expression
    if (expr.type === 'CaseExpr') return; // CASE is complex; skip deep validation
    // Identifier that's not in GROUP BY
    if (expr.type === 'Identifier') {
      throw new OracleError(979, `not a GROUP BY expression`);
    }
  }

  private normalizeExprKey(expr: Expression): string {
    if (expr.type === 'Identifier') {
      const tbl = (expr as IdentifierExpr).table?.toUpperCase() || '';
      return tbl ? `${tbl}.${expr.name.toUpperCase()}` : expr.name.toUpperCase();
    }
    if (expr.type === 'Literal') return `LIT:${expr.value}`;
    if (expr.type === 'FunctionCall') return `FN:${expr.name.toUpperCase()}(${expr.args.map(a => this.normalizeExprKey(a)).join(',')})`;
    if (expr.type === 'BinaryExpr') return `${this.normalizeExprKey(expr.left)}${expr.operator}${this.normalizeExprKey(expr.right)}`;
    return `?:${expr.type}`;
  }

  private performGroupBy(rows: StorageRow[], columns: StorageColMeta[], stmt: SelectStatement): { key: CellValue[]; rows: StorageRow[] }[] {
    if (!stmt.groupBy || stmt.groupBy.length === 0) {
      // No GROUP BY but has aggregates — treat all rows as one group
      return [{ key: [], rows }];
    }

    const groupMap = new Map<string, { key: CellValue[]; rows: StorageRow[] }>();
    for (const row of rows) {
      const keyValues = stmt.groupBy!.map(expr => this.evaluateExpression(expr, row, columns));
      const keyStr = JSON.stringify(keyValues);
      if (!groupMap.has(keyStr)) {
        groupMap.set(keyStr, { key: keyValues, rows: [] });
      }
      groupMap.get(keyStr)!.rows.push(row);
    }

    return Array.from(groupMap.values());
  }

  private projectGroupedRows(
    groups: { key: CellValue[]; rows: StorageRow[] }[],
    columns: StorageColMeta[],
    stmt: SelectStatement
  ): ResultSet {
    const resultColumns: ColumnMeta[] = [];
    const resultRows: Row[] = [];

    // Build column metadata from first call
    for (const item of stmt.columns) {
      const name = item.alias || this.exprToString(item.expr);
      resultColumns.push({ name, dataType: parseOracleType('VARCHAR2') });
    }

    for (const group of groups) {
      const row: CellValue[] = [];
      for (const item of stmt.columns) {
        row.push(this.evaluateExpressionGrouped(item.expr, group.rows, columns));
      }
      resultRows.push(row);
    }

    // ORDER BY on grouped results
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      resultRows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          const idx = this.resolveOrderByIndexGrouped(ob.expr, stmt.columns, columns);
          if (idx < 0) continue;
          const cmp = this.compareWithOrderSpec(a[idx], b[idx], ob);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    return queryResult(resultColumns, resultRows);
  }

  // ── Window Function Evaluation ──────────────────────────────────

  private evaluateWindowFunctions(
    resultRows: Row[],
    sourceRows: StorageRow[],
    sourceColumns: StorageColMeta[],
    selectItems: SelectItem[],
    windowColIndices: number[]
  ): void {
    for (const colIdx of windowColIndices) {
      const funcExpr = selectItems[colIdx].expr as FunctionCallExpr;
      const windowSpec = funcExpr.over!;
      const funcName = funcExpr.name.toUpperCase();

      // Build array of { sourceRowIdx, partitionKey }
      const rowInfos: { srcIdx: number; partKey: string }[] = sourceRows.map((row, i) => {
        const partValues = (windowSpec.partitionBy || []).map(e => this.evaluateExpression(e, row, sourceColumns));
        return { srcIdx: i, partKey: JSON.stringify(partValues) };
      });

      // Group by partition key
      const partitions = new Map<string, number[]>();
      for (let i = 0; i < rowInfos.length; i++) {
        const key = rowInfos[i].partKey;
        if (!partitions.has(key)) partitions.set(key, []);
        partitions.get(key)!.push(i);
      }

      const impl = resolveWindowFunction(funcName);
      // Real Oracle rejects an unknown analytic function instead of
      // silently producing NULLs.
      if (!impl) throw new OracleError(904, `"${funcName}": invalid identifier`);

      // For each partition, sort indices by window ORDER BY and compute
      for (const [, indices] of partitions) {
        // Sort within partition
        if (windowSpec.orderBy && windowSpec.orderBy.length > 0) {
          indices.sort((a, b) => {
            for (const ob of windowSpec.orderBy!) {
              const va = this.evaluateExpression(ob.expr, sourceRows[a], sourceColumns);
              const vb = this.evaluateExpression(ob.expr, sourceRows[b], sourceColumns);
              const cmp = this.compareWithOrderSpec(va, vb, ob);
              if (cmp !== 0) return cmp;
            }
            return 0;
          });
        }

        const partition: WindowPartition = {
          size: indices.length,
          argCount: funcExpr.args.length,
          star: funcExpr.args.length === 0 || funcExpr.args[0]?.type === 'Star',
          arg: (i, pos) => this.evaluateExpression(funcExpr.args[i], sourceRows[indices[pos]], sourceColumns),
          frame: (pos) => this.resolveFramePositions(windowSpec, indices.length, pos),
          rowsEqual: (a, b) => this.windowRowsEqual(windowSpec, sourceRows[indices[a]], sourceRows[indices[b]], sourceColumns),
          compare: (a, b) => this.compareValues(a, b),
        };
        const values = impl(partition);
        for (let pos = 0; pos < indices.length; pos++) {
          resultRows[indices[pos]][colIdx] = values[pos];
        }
      }
    }
  }

  private windowRowsEqual(
    windowSpec: import('../engine/parser/ASTNode').WindowSpec,
    rowA: StorageRow,
    rowB: StorageRow,
    columns: StorageColMeta[]
  ): boolean {
    if (!windowSpec.orderBy) return true;
    for (const ob of windowSpec.orderBy) {
      const va = this.evaluateExpression(ob.expr, rowA, columns);
      const vb = this.evaluateExpression(ob.expr, rowB, columns);
      if (this.compareValues(va, vb) !== 0) return false;
    }
    return true;
  }

  /** Window-frame positions (0-based, within the partition) for `pos`. */
  private resolveFramePositions(
    windowSpec: import('../engine/parser/ASTNode').WindowSpec,
    partitionSize: number,
    posInPartition: number
  ): number[] {
    const positions = (start: number, end: number): number[] => {
      if (start > end) return [];
      return Array.from({ length: end - start + 1 }, (_, i) => start + i);
    };
    const frame = windowSpec.frame;
    if (!frame) {
      // Default frame: if ORDER BY present, UNBOUNDED PRECEDING to CURRENT ROW; else whole partition
      const hasOrderBy = windowSpec.orderBy && windowSpec.orderBy.length > 0;
      return positions(0, hasOrderBy ? posInPartition : partitionSize - 1);
    }
    const resolveBound = (bound: import('../engine/parser/ASTNode').FrameBound): number => {
      switch (bound.type) {
        case 'UNBOUNDED_PRECEDING': return 0;
        case 'UNBOUNDED_FOLLOWING': return partitionSize - 1;
        case 'CURRENT_ROW': return posInPartition;
        case 'PRECEDING': {
          const n = bound.value ? Number(this.evaluateExpression(bound.value, [], [])) : 1;
          return Math.max(0, posInPartition - n);
        }
        case 'FOLLOWING': {
          const n = bound.value ? Number(this.evaluateExpression(bound.value, [], [])) : 1;
          return Math.min(partitionSize - 1, posInPartition + n);
        }
      }
    };
    const start = resolveBound(frame.start);
    const end = frame.end ? resolveBound(frame.end) : posInPartition; // single bound defaults end to CURRENT ROW
    return positions(start, end);
  }

  private evaluateExpressionGrouped(expr: Expression, groupRows: StorageRow[], columns: StorageColMeta[]): CellValue {
    if (expr.type === 'FunctionCall') {
      const name = expr.name.toUpperCase();
      if (['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'MEDIAN', 'STDDEV', 'VARIANCE', 'LISTAGG'].includes(name)) {
        return this.evaluateAggregate(name, expr, groupRows, columns);
      }
      // Non-aggregate function: evaluate using first row
      return this.evaluateExpression(expr, groupRows[0] || [], columns);
    }
    if (expr.type === 'BinaryExpr') {
      const left = this.evaluateExpressionGrouped(expr.left, groupRows, columns);
      const right = this.evaluateExpressionGrouped(expr.right, groupRows, columns);
      return this.applyBinaryOp(expr.operator, left, right);
    }
    // Non-aggregate column — use first row in group
    return this.evaluateExpression(expr, groupRows[0] || [], columns);
  }

  private evaluateAggregate(name: string, expr: FunctionCallExpr, groupRows: StorageRow[], columns: StorageColMeta[]): CellValue {
    if (name === 'COUNT') {
      if (expr.args.length === 0 || (expr.args[0] && expr.args[0].type === 'Star')) {
        return groupRows.length;
      }
      if (expr.distinct) {
        const unique = new Set<string>();
        for (const row of groupRows) {
          const val = this.evaluateExpression(expr.args[0], row, columns);
          if (val != null) unique.add(JSON.stringify(val));
        }
        return unique.size;
      }
      let count = 0;
      for (const row of groupRows) {
        if (this.evaluateExpression(expr.args[0], row, columns) != null) count++;
      }
      return count;
    }

    // Collect non-null values
    const values: number[] = [];
    for (const row of groupRows) {
      const val = this.evaluateExpression(expr.args[0], row, columns);
      if (val != null) values.push(Number(val));
    }

    if (values.length === 0) return null;

    switch (name) {
      case 'SUM': return values.reduce((a, b) => a + b, 0);
      case 'AVG': return values.reduce((a, b) => a + b, 0) / values.length;
      case 'MIN': {
        // Support string comparison
        const allVals = groupRows
          .map(row => this.evaluateExpression(expr.args[0], row, columns))
          .filter(v => v != null);
        return allVals.reduce((a, b) => this.compareValues(a, b) <= 0 ? a : b);
      }
      case 'MAX': {
        const allVals = groupRows
          .map(row => this.evaluateExpression(expr.args[0], row, columns))
          .filter(v => v != null);
        return allVals.reduce((a, b) => this.compareValues(a, b) >= 0 ? a : b);
      }
      case 'MEDIAN': {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
      }
      case 'STDDEV': {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
        return values.length === 1 ? 0 : Math.sqrt(variance);
      }
      case 'VARIANCE': {
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        return values.length === 1 ? 0 : values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
      }
      case 'LISTAGG': {
        // LISTAGG(expr, delimiter) — collect string values
        const strVals: string[] = [];
        for (const row of groupRows) {
          const val = this.evaluateExpression(expr.args[0], row, columns);
          if (val != null) strVals.push(String(val));
        }
        const delimiter = expr.args.length > 1
          ? String(this.evaluateExpression(expr.args[1], groupRows[0], columns) ?? ',')
          : '';
        return strVals.join(delimiter);
      }
      default: return null;
    }
  }

  private evaluateConditionAggregate(expr: Expression, groupRows: StorageRow[], columns: StorageColMeta[]): boolean {
    if (expr.type === 'ParenExpr') {
      return this.evaluateConditionAggregate(expr.expr, groupRows, columns);
    }
    if (expr.type === 'BinaryExpr') {
      if (expr.operator === 'AND') {
        return this.evaluateConditionAggregate(expr.left, groupRows, columns)
          && this.evaluateConditionAggregate(expr.right, groupRows, columns);
      }
      if (expr.operator === 'OR') {
        return this.evaluateConditionAggregate(expr.left, groupRows, columns)
          || this.evaluateConditionAggregate(expr.right, groupRows, columns);
      }
      const left = this.evaluateExpressionGrouped(expr.left, groupRows, columns);
      const right = this.evaluateExpressionGrouped(expr.right, groupRows, columns);
      return this.applyComparison(expr.operator, left, right);
    }
    return !!this.evaluateExpressionGrouped(expr, groupRows, columns);
  }

  private resolveOrderByIndex(
    expr: Expression,
    selectCols: { name: string; alias?: string; colIndex: number; expr?: Expression }[],
    sourceCols: StorageColMeta[]
  ): number {
    // By column position number
    if (expr.type === 'Literal' && expr.dataType === 'number') {
      return Number(expr.value) - 1;
    }
    // By name/alias in SELECT list first
    if (expr.type === 'Identifier') {
      const name = expr.name.toUpperCase();
      const table = expr.table?.toUpperCase();

      // If qualified (e.g. E.DEPARTMENT_ID), try to match in select cols directly
      if (!table) {
        const idx = selectCols.findIndex(c => (c.alias || c.name).toUpperCase() === name || c.name.toUpperCase() === name);
        if (idx >= 0) return idx;
      }

      // Fall through to source columns — use resolveColumnIndex for ambiguity detection
      // This will throw ORA-00918 if the column is ambiguous in source
      const srcIdx = this.resolveColumnIndex(expr, sourceCols);
      if (srcIdx >= 0) {
        // Map source column index to select column index if possible
        const selIdx = selectCols.findIndex(c => c.colIndex === srcIdx);
        if (selIdx >= 0) return selIdx;
      }
    }
    return -1;
  }

  private resolveOrderByIndexGrouped(
    expr: Expression,
    selectItems: SelectItem[],
    sourceCols: StorageColMeta[]
  ): number {
    if (expr.type === 'Literal' && expr.dataType === 'number') {
      return Number(expr.value) - 1;
    }
    if (expr.type === 'Identifier') {
      const name = expr.name.toUpperCase();
      const idx = selectItems.findIndex(item => {
        if (item.alias && item.alias.toUpperCase() === name) return true;
        if (item.expr.type === 'Identifier' && item.expr.name.toUpperCase() === name) return true;
        return false;
      });
      if (idx >= 0) return idx;
    }
    return -1;
  }

  // ── Set Operations ─────────────────────────────────────────────

  private executeSetOperation(stmt: SelectStatement): ResultSet {
    // Execute left side (without the setOp)
    const leftStmt: SelectStatement = { ...stmt, setOp: undefined };
    const leftResult = this.executeSelect(leftStmt);

    // Execute right side
    const rightResult = this.executeSelect(stmt.setOp!.right);

    // ORA-01789: validate column count match
    if (leftResult.columns.length !== rightResult.columns.length) {
      throw new OracleError(1789, 'query block has incorrect number of result columns');
    }

    const op = stmt.setOp!.op;

    if (op === 'UNION_ALL') {
      return queryResult(leftResult.columns, [...leftResult.rows, ...rightResult.rows]);
    }

    if (op === 'UNION') {
      const combined = [...leftResult.rows, ...rightResult.rows];
      const seen = new Set<string>();
      const unique = combined.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return queryResult(leftResult.columns, unique);
    }

    if (op === 'INTERSECT') {
      const rightKeys = new Set(rightResult.rows.map(r => JSON.stringify(r)));
      const seen = new Set<string>();
      const intersection = leftResult.rows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        if (rightKeys.has(key)) { seen.add(key); return true; }
        return false;
      });
      return queryResult(leftResult.columns, intersection);
    }

    if (op === 'MINUS' || op === 'EXCEPT') {
      const rightKeys = new Set(rightResult.rows.map(r => JSON.stringify(r)));
      const seen = new Set<string>();
      const difference = leftResult.rows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        if (!rightKeys.has(key)) { seen.add(key); return true; }
        return false;
      });
      return queryResult(leftResult.columns, difference);
    }

    return leftResult;
  }

  // ── CONNECT BY (hierarchical queries) ────────────────────────────

  private executeConnectBy(rows: StorageRow[], columns: StorageColMeta[], connectBy: ConnectByClause): StorageRow[] {
    // Find root rows (matching START WITH if present)
    let rootRows: StorageRow[];
    if (connectBy.startWith) {
      rootRows = rows.filter(row => this.evaluateCondition(connectBy.startWith!, row, columns));
    } else {
      rootRows = [...rows];
    }

    // Add a LEVEL pseudo-column to column metadata if not present
    const levelColName = '__CONNECT_BY_LEVEL__';
    const hasLevelCol = columns.some(c => c.name === levelColName);
    if (!hasLevelCol) {
      columns.push({
        name: levelColName,
        dataType: parseOracleType('NUMBER'),
        ordinalPosition: columns.length,
        _qualifiedNames: ['LEVEL', levelColName],
      } as StorageColMeta & { _qualifiedNames: string[] });
      // Extend existing rows with null for the new column
      for (const row of rows) row.push(null);
    }
    const levelIdx = columns.findIndex(c => c.name === levelColName);

    const result: StorageRow[] = [];
    const visited = new Set<string>();

    // Safety cap matching Oracle's default ORA-30009 threshold (10000).
    const MAX_DEPTH = 10000;

    const traverse = (parentRow: StorageRow, level: number) => {
      const rowKey = JSON.stringify(parentRow) + '#' + level;
      if (connectBy.noCycle && visited.has(rowKey)) return;
      if (level > MAX_DEPTH) return;

      visited.add(rowKey);
      const rowWithLevel = [...parentRow];
      rowWithLevel[levelIdx] = level;
      result.push(rowWithLevel);

      // Find children by re-evaluating the CONNECT BY condition. The
      // candidate child's LEVEL pseudo-column must reflect what its
      // depth *would be* if it were emitted, otherwise predicates like
      // `LEVEL <= N` never terminate the recursion correctly.
      const childLevel = level + 1;
      for (const childRow of rows) {
        const childWithLevel = [...childRow];
        childWithLevel[levelIdx] = childLevel;
        const ok = this.evaluateConnectByCondition(connectBy.condition, rowWithLevel, childWithLevel, columns);
        if (ok) {
          traverse(childWithLevel, childLevel);
        }
      }

      visited.delete(rowKey);
    };

    // Seed traversal: root rows get LEVEL=1. Without PRIOR / START WITH
    // and a single-row source (e.g. DUAL), this is the standard "row
    // generator" idiom.
    for (const root of rootRows) {
      const rootWithLevel = [...root];
      rootWithLevel[levelIdx] = 1;
      // The first emission is unconditional only when the predicate
      // accepts LEVEL=1 — real Oracle still applies the CONNECT BY
      // filter to the root, except that LEVEL=1 always satisfies a
      // `LEVEL <= N` style guard.
      traverse(rootWithLevel, 1);
    }

    return result;
  }

  private evaluateConnectByCondition(
    expr: Expression, parentRow: StorageRow, childRow: StorageRow, columns: StorageColMeta[]
  ): boolean {
    // Handle PRIOR keyword: In CONNECT BY PRIOR x = y, PRIOR binds to the parent row
    if (expr.type === 'BinaryExpr') {
      if (expr.operator === 'AND') {
        return this.evaluateConnectByCondition(expr.left, parentRow, childRow, columns)
            && this.evaluateConnectByCondition(expr.right, parentRow, childRow, columns);
      }
      if (expr.operator === 'OR') {
        return this.evaluateConnectByCondition(expr.left, parentRow, childRow, columns)
            || this.evaluateConnectByCondition(expr.right, parentRow, childRow, columns);
      }

      // For comparison operators, resolve PRIOR references to parent row
      const left = this.evaluateConnectByExpr(expr.left, parentRow, childRow, columns);
      const right = this.evaluateConnectByExpr(expr.right, parentRow, childRow, columns);
      return this.applyComparison(expr.operator, left, right);
    }
    return this.evaluateCondition(expr, childRow, columns);
  }

  private evaluateConnectByExpr(
    expr: Expression, parentRow: StorageRow, childRow: StorageRow, columns: StorageColMeta[]
  ): CellValue {
    // PRIOR identifier → evaluate against parent row
    if (expr.type === 'UnaryExpr' && expr.operator === 'PRIOR') {
      return this.evaluateExpression(expr.operand, parentRow, columns);
    }
    // Regular expression → evaluate against child row
    return this.evaluateExpression(expr, childRow, columns);
  }

  // ── MERGE ──────────────────────────────────────────────────────────

  private executeMerge(stmt: MergeStatement): ResultSet {
    const targetSchema = this.resolveSchema(stmt.target.schema);
    const targetName = stmt.target.name.toUpperCase();

    const targetMeta = this.requireTableMeta(targetSchema, targetName);

    // Load source data
    let sourceRows: StorageRow[];
    let sourceCols: StorageColMeta[];
    if (stmt.source.type === 'TableRef') {
      const loaded = this.loadTable(stmt.source);
      sourceRows = loaded.rows;
      sourceCols = loaded.columns;
    } else {
      // Subquery source
      const subResult = this.executeSelect(stmt.source.query);
      sourceRows = subResult.rows as StorageRow[];
      sourceCols = subResult.columns.map((c, i) => ({
        name: c.name, dataType: c.dataType, ordinalPosition: i,
      }));
    }

    let updatedCount = 0;
    let insertedCount = 0;
    const targetAlias = (stmt.target.alias || stmt.target.name).toUpperCase();
    const sourceAlias = (stmt.source.type === 'TableRef'
      ? (stmt.source.alias || stmt.source.name)
      : (stmt.source as { alias?: string }).alias || 'SOURCE').toUpperCase();
    const combinedCols = [
      ...targetMeta.columns.map((c, i) => ({
        ...c, ordinalPosition: i,
        _qualifiedNames: [`${targetAlias}.${c.name}`],
      })),
      ...sourceCols.map((c, i) => ({
        ...c, ordinalPosition: targetMeta.columns.length + i,
        _qualifiedNames: [`${sourceAlias}.${c.name}`],
      })),
    ];

    for (const srcRow of sourceRows) {
      // Find matching target rows
      const targetRows = this.storage.getRows(targetSchema, targetName);
      let matched = false;

      for (let tIdx = 0; tIdx < targetRows.length; tIdx++) {
        const combinedRow = [...targetRows[tIdx], ...srcRow] as StorageRow;
        if (this.evaluateCondition(stmt.on, combinedRow, combinedCols)) {
          matched = true;
          // WHEN MATCHED THEN UPDATE
          if (stmt.whenMatched) {
            const newRow = [...targetRows[tIdx]];
            for (const assign of stmt.whenMatched.assignments) {
              const colIdx = targetMeta.columns.findIndex(c => c.name.toUpperCase() === assign.column.toUpperCase());
              if (colIdx >= 0) {
                newRow[colIdx] = this.evaluateExpression(assign.value, combinedRow, combinedCols);
              }
            }
            this.storage.updateRows(targetSchema, targetName,
              (row) => JSON.stringify(row) === JSON.stringify(targetRows[tIdx]),
              () => newRow
            );
            updatedCount++;
          }
          break;
        }
      }

      if (!matched && stmt.whenNotMatched) {
        // WHEN NOT MATCHED THEN INSERT
        const newRow: StorageRow = new Array(targetMeta.columns.length).fill(null);
        const combinedRow = [...new Array(targetMeta.columns.length).fill(null), ...srcRow] as StorageRow;
        for (let i = 0; i < stmt.whenNotMatched.columns.length && i < stmt.whenNotMatched.values.length; i++) {
          const colIdx = targetMeta.columns.findIndex(c => c.name.toUpperCase() === stmt.whenNotMatched!.columns[i].toUpperCase());
          if (colIdx >= 0) {
            newRow[colIdx] = this.evaluateExpression(stmt.whenNotMatched.values[i], combinedRow, combinedCols);
          }
        }
        this.storage.insertRow(targetSchema, targetName, newRow);
        insertedCount++;
      }
    }

    const parts: string[] = [];
    if (updatedCount > 0) parts.push(`${updatedCount} row${updatedCount !== 1 ? 's' : ''} merged (updated)`);
    if (insertedCount > 0) parts.push(`${insertedCount} row${insertedCount !== 1 ? 's' : ''} merged (inserted)`);
    return emptyResult(parts.join(', ') || 'Merge complete.', updatedCount + insertedCount);
  }

  private applySelectClauses(result: ResultSet, stmt: SelectStatement): ResultSet {
    let rows = result.rows;

    // WHERE
    if (stmt.where) {
      rows = rows.filter(row => {
        const colMetas: StorageColMeta[] = result.columns.map((c, i) => ({
          name: c.name, dataType: c.dataType, ordinalPosition: i,
        }));
        return this.evaluateCondition(stmt.where!, row as StorageRow, colMetas);
      });
    }

    // ORDER BY (before projection so we can reference original column positions)
    const colMetas: StorageColMeta[] = result.columns.map((c, i) => ({
      name: c.name, dataType: c.dataType, ordinalPosition: i,
    }));
    if (stmt.orderBy && stmt.orderBy.length > 0) {
      rows = [...rows];
      rows.sort((a, b) => {
        for (const ob of stmt.orderBy!) {
          const colIdx = this.resolveColumnIndex(ob.expr, colMetas);
          if (colIdx < 0) continue;
          const cmp = this.compareWithOrderSpec(a[colIdx], b[colIdx], ob);
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    // Column projection (SELECT col1, col2, ... or SELECT *)
    let resultCols = result.columns;
    const isSelectAll = stmt.columns.length === 1 && stmt.columns[0].expr.type === 'Star';
    if (!isSelectAll) {
      const projectedCols: ColumnMeta[] = [];
      const colIndices: number[] = [];
      for (const selCol of stmt.columns) {
        if (selCol.expr.type === 'Identifier') {
          const colName = (selCol.expr as import('../engine/parser/ASTNode').IdentifierExpr).name.toUpperCase();
          const idx = colMetas.findIndex(c => c.name === colName);
          if (idx >= 0) {
            colIndices.push(idx);
            projectedCols.push({ name: selCol.alias?.toUpperCase() || colName, dataType: result.columns[idx].dataType });
          } else {
            // ORA-00904: column not found in catalog view
            const knownPseudo = ['SYSDATE', 'CURRENT_DATE', 'SYSTIMESTAMP', 'CURRENT_TIMESTAMP', 'USER', 'ROWNUM'].includes(colName);
            if (!knownPseudo) {
              throw new OracleError(904, `"${colName}": invalid identifier`);
            }
            colIndices.push(-1);
            projectedCols.push({ name: selCol.alias?.toUpperCase() || colName, dataType: { type: 'VARCHAR2', length: 30 } });
          }
        } else {
          // Expression (function call, etc.) — evaluate at runtime
          colIndices.push(-2);
          const alias = selCol.alias?.toUpperCase() || (selCol.expr.type === 'Identifier' ? (selCol.expr as IdentifierExpr).name.toUpperCase() : 'EXPR');
          projectedCols.push({ name: alias, dataType: { type: 'VARCHAR2', length: 4000 } });
        }
      }
      rows = rows.map(row => colIndices.map((idx, i) => {
        if (idx >= 0) return row[idx];
        if (idx === -2) {
          return this.evaluateExpression(stmt.columns[i].expr, row as StorageRow, colMetas);
        }
        return null;
      }));
      resultCols = projectedCols;
    }

    // DISTINCT
    if (stmt.distinct) {
      const seen = new Set<string>();
      rows = rows.filter(row => {
        const key = JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // FETCH / OFFSET
    if (stmt.fetch) {
      let offset = 0;
      if (stmt.fetch.offset) offset = Number(this.evaluateExpression(stmt.fetch.offset, [], []));
      let limit = rows.length;
      if (stmt.fetch.count) limit = Number(this.evaluateExpression(stmt.fetch.count, [], []));
      rows = rows.slice(offset, offset + limit);
    }

    return { ...result, columns: resultCols, rows };
  }

  // ── Shared object-resolution helpers ─────────────────────────────
  // Deduplicated from the statement handlers: every DML/DDL handler used
  // to inline the same schema fallback, ORA-00942 table check and
  // ORA-00904 column lookup.

  /** Resolve an optional schema qualifier against the session schema. */
  private resolveSchema(explicit?: string | null): string {
    return (explicit || this.context.currentSchema).toUpperCase();
  }

  /** Look up a table's metadata or raise ORA-00942 like real Oracle. */
  private requireTableMeta(schema: string, tableName: string): TableMeta {
    const meta = this.storage.getTableMeta(schema, tableName);
    if (!meta) throw new OracleError(942, 'table or view does not exist');
    return meta;
  }

  /** Resolve a column name to its ordinal or raise ORA-00904. */
  private requireColumnIndex(tableMeta: TableMeta, colName: string): number {
    const idx = this.findColumnIndex(tableMeta, colName);
    if (idx < 0) throw new OracleError(904, `"${colName.toUpperCase()}": invalid identifier`);
    return idx;
  }

  /** Case-insensitive column lookup; -1 when absent. */
  private findColumnIndex(tableMeta: TableMeta, colName: string): number {
    const up = colName.toUpperCase();
    return tableMeta.columns.findIndex(c => c.name.toUpperCase() === up);
  }

  // ── INSERT ────────────────────────────────────────────────────────

  private executeInsert(stmt: InsertStatement): ResultSet {
    this.txn.begin();
    const schema = this.resolveSchema(stmt.table.schema);
    const tableName = stmt.table.name.toUpperCase();
    const tableMeta = this.requireTableMeta(schema, tableName);
    this.privileges.requireObjectAccess(schema, tableName, 'INSERT');
    let insertedCount = 0;

    if (stmt.values) {
      for (const valueList of stmt.values) {
        const row = this.buildInsertRow(tableMeta, stmt.columns, valueList);
        this.constraints.validateConstraints(schema, tableName, tableMeta, row);
        this.constraints.validateDataTypes(schema, tableName, tableMeta, row);
        this.storage.insertRow(schema, tableName, row);
        insertedCount++;
      }
    } else if (stmt.query) {
      // INSERT INTO ... SELECT — execute subquery and validate column count
      const subResult = this.executeSelect(stmt.query);
      const expectedCols = stmt.columns ? stmt.columns.length : tableMeta.columns.length;
      if (subResult.columns.length > expectedCols) {
        throw new OracleError(913, 'too many values');
      }
      if (subResult.columns.length < expectedCols) {
        throw new OracleError(947, 'not enough values');
      }
      for (const subRow of subResult.rows) {
        const row: StorageRow = new Array(tableMeta.columns.length).fill(null);
        if (stmt.columns) {
          for (let i = 0; i < stmt.columns.length; i++) {
            const colIdx = this.findColumnIndex(tableMeta, stmt.columns![i]);
            if (colIdx >= 0) row[colIdx] = subRow[i] as CellValue;
          }
        } else {
          for (let i = 0; i < subResult.columns.length && i < tableMeta.columns.length; i++) {
            row[i] = subRow[i] as CellValue;
          }
        }
        this.constraints.validateConstraints(schema, tableName, tableMeta, row);
        this.constraints.validateDataTypes(schema, tableName, tableMeta, row);
        this.storage.insertRow(schema, tableName, row);
        insertedCount++;
      }
    }

    // Oracle SQL*Plus reports "<n> row[s] created." (not "inserted").
    return emptyResult(`${insertedCount} row${insertedCount !== 1 ? 's' : ''} created.`, insertedCount);
  }

  private buildInsertRow(tableMeta: import('../engine/storage/BaseStorage').TableMeta, columns: string[] | undefined, values: Expression[]): StorageRow {
    const row: StorageRow = new Array(tableMeta.columns.length).fill(null);

    if (columns) {
      for (const colName of columns) this.requireColumnIndex(tableMeta, colName);
      if (values.length > columns.length) throw new OracleError(913, 'too many values');
      if (values.length < columns.length) throw new OracleError(947, 'not enough values');
      for (let i = 0; i < columns.length && i < values.length; i++) {
        row[this.requireColumnIndex(tableMeta, columns[i])] = this.evaluateExpression(values[i], [], []);
      }
    } else {
      if (values.length > tableMeta.columns.length) throw new OracleError(913, 'too many values');
      if (values.length < tableMeta.columns.length) throw new OracleError(947, 'not enough values');
      for (let i = 0; i < values.length && i < tableMeta.columns.length; i++) {
        row[i] = this.evaluateExpression(values[i], [], []);
      }
    }

    // Apply defaults for missing values
    for (let i = 0; i < tableMeta.columns.length; i++) {
      if (row[i] === null && tableMeta.columns[i].defaultValue !== undefined) {
        row[i] = tableMeta.columns[i].defaultValue!;
      }
    }

    return row;
  }

  // ── UPDATE ────────────────────────────────────────────────────────

  private executeUpdate(stmt: UpdateStatement): ResultSet {
    this.txn.begin();
    const schema = this.resolveSchema(stmt.table.schema);
    const tableName = stmt.table.name.toUpperCase();
    const tableMeta = this.requireTableMeta(schema, tableName);
    this.privileges.requireObjectAccess(schema, tableName, 'UPDATE');

    for (const assign of stmt.assignments) this.requireColumnIndex(tableMeta, assign.column);

    const count = this.storage.updateRows(
      schema, tableName,
      (row) => !stmt.where || this.evaluateCondition(stmt.where, row, tableMeta.columns),
      (row) => {
        const newRow = [...row];
        for (const assign of stmt.assignments) {
          const colIdx = this.findColumnIndex(tableMeta, assign.column);
          if (colIdx >= 0) {
            newRow[colIdx] = this.evaluateExpression(assign.value, row, tableMeta.columns);
          }
        }
        // Validate constraints on updated row (UNIQUE, PK, NOT NULL, FK, CHECK).
        // Pass the pre-update row so uniqueness checks can exclude it
        // from the existing-row set (otherwise an UPDATE that leaves
        // the PK column unchanged would self-conflict).
        this.constraints.validateConstraints(schema, tableName, tableMeta, newRow, row);
        this.constraints.validateDataTypes(schema, tableName, tableMeta, newRow);
        return newRow;
      }
    );

    return emptyResult(`${count} row${count !== 1 ? 's' : ''} updated.`, count);
  }

  // ── DELETE ────────────────────────────────────────────────────────

  private executeDelete(stmt: DeleteStatement): ResultSet {
    this.txn.begin();
    const schema = this.resolveSchema(stmt.table.schema);
    const tableName = stmt.table.name.toUpperCase();
    const tableMeta = this.requireTableMeta(schema, tableName);
    this.privileges.requireObjectAccess(schema, tableName, 'DELETE');

    // Validate FK constraints on rows to be deleted
    const rowsToDelete = this.storage.getRows(schema, tableName)
      .filter(row => !stmt.where || this.evaluateCondition(stmt.where, row, tableMeta.columns));
    for (const row of rowsToDelete) {
      this.constraints.validateDeleteForeignKeys(schema, tableName, row);
    }

    const count = this.storage.deleteRows(
      schema, tableName,
      (row) => !stmt.where || this.evaluateCondition(stmt.where, row, tableMeta.columns),
    );

    return emptyResult(`${count} row${count !== 1 ? 's' : ''} deleted.`, count);
  }

  // ── DDL ───────────────────────────────────────────────────────────

  /**
   * CREATE [PUBLIC] DATABASE LINK — persists the link in the catalog so
   * DBA_DB_LINKS reflects it and DROP has something real to remove. The
   * simulator does not dispatch queries across links (documented limit);
   * the dictionary, at least, must not lie about what exists.
   */
  private executeCreateDbLink(
    stmt: import('../engine/parser/ASTNode').CreateDbLinkStatement,
  ): ResultSet {
    const owner = stmt.isPublic ? 'PUBLIC' : this.context.currentUser;
    const name = stmt.name.toUpperCase();
    this.privileges.requireSystemPrivilege(
      stmt.isPublic ? 'CREATE PUBLIC DATABASE LINK' : 'CREATE DATABASE LINK');
    if (this.catalog.getDbLink(owner, name)) {
      throw new OracleError(2011, 'duplicate database link name');
    }
    this.catalog.registerDbLink({
      owner, name,
      username: stmt.connectUser ? stmt.connectUser.toUpperCase() : null,
      host: stmt.usingAlias ?? null,
      created: new Date(),
    });
    this.emitDdl('CREATE DATABASE LINK', `${owner}.${name}`);
    return emptyResult('Database link created.');
  }

  private executeDropDbLink(
    stmt: import('../engine/parser/ASTNode').DropDbLinkStatement,
  ): ResultSet {
    const owner = stmt.isPublic ? 'PUBLIC' : this.context.currentUser;
    const name = stmt.name.toUpperCase();
    if (!this.catalog.dropDbLink(owner, name)) {
      throw new OracleError(2024, 'database link not found');
    }
    this.emitDdl('DROP DATABASE LINK', `${owner}.${name}`);
    return emptyResult('Database link dropped.');
  }

  /**
   * CREATE MATERIALIZED VIEW — a real object, not a success-message stub:
   * the defining query is executed (BUILD IMMEDIATE) into a genuine
   * storage table (which is what makes SELECT work afterwards) and the
   * dictionary side (query, refresh metadata, staleness, base tables)
   * is registered in the catalog for DBA_MVIEWS and DBMS_MVIEW.REFRESH.
   */
  private executeCreateMaterializedView(
    stmt: import('../engine/parser/ASTNode').CreateMaterializedViewStatement,
  ): ResultSet {
    const owner = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();

    if (owner === this.context.currentUser) {
      this.privileges.requireSystemPrivilege('CREATE MATERIALIZED VIEW', 'CREATE ANY MATERIALIZED VIEW');
    } else {
      this.privileges.requireSystemPrivilege('CREATE ANY MATERIALIZED VIEW');
    }
    if (this.storage.tableExists(owner, name) || this.catalog.getMaterializedView(owner, name)) {
      throw new OracleError(955, 'name is already used by an existing object');
    }

    const result = this.executeSelect(stmt.query);
    const columns: StorageColMeta[] = result.columns.map((col, i) => ({
      name: col.name, dataType: col.dataType, ordinalPosition: i,
    }));
    this.storage.ensureSchema(owner);
    this.storage.createTable({
      schema: owner, name, columns, constraints: [],
      tablespace: 'USERS', rowCount: 0,
    });
    // BUILD DEFERRED creates an empty (unusable until refreshed) container.
    const deferred = stmt.buildMode === 'DEFERRED';
    if (!deferred) {
      for (const row of result.rows) this.storage.insertRow(owner, name, row as StorageRow);
    }
    this.catalog.registerMaterializedView({
      owner, name,
      queryAst: stmt.query,
      queryText: stmt.queryText ?? '',
      buildMode: stmt.buildMode ?? 'IMMEDIATE',
      refreshMethod: stmt.refreshMethod ?? 'FORCE',
      refreshMode: stmt.refreshMode ?? 'DEMAND',
      baseTables: this.collectBaseTables(stmt.query),
      lastRefresh: deferred ? null : new Date(),
      staleness: deferred ? 'UNUSABLE' : 'FRESH',
    });
    this.emitDdl('CREATE MATERIALIZED VIEW', `${owner}.${name}`);
    return emptyResult('Materialized view created.');
  }

  private executeDropMaterializedView(
    stmt: import('../engine/parser/ASTNode').DropMaterializedViewStatement,
  ): ResultSet {
    const owner = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    const meta = this.catalog.getMaterializedView(owner, name);
    if (!meta) {
      throw new OracleError(12003, `materialized view "${owner}"."${name}" does not exist`);
    }
    this.catalog.dropMaterializedView(owner, name);
    if (this.storage.tableExists(owner, name)) this.storage.dropTable(owner, name);
    this.emitDdl('DROP MATERIALIZED VIEW', `${owner}.${name}`);
    return emptyResult('Materialized view dropped.');
  }

  /**
   * Complete refresh: re-run the defining query and replace the container
   * rows. Exposed for DBMS_MVIEW.REFRESH. ORA-12003 when unknown.
   */
  refreshMaterializedView(owner: string, name: string): void {
    const o = owner.toUpperCase(); const n = name.toUpperCase();
    const meta = this.catalog.getMaterializedView(o, n);
    if (!meta) {
      throw new OracleError(12003, `materialized view "${o}"."${n}" does not exist`);
    }
    const result = this.executeSelect(meta.queryAst as SelectStatement);
    this.storage.deleteRows(o, n, () => true);
    for (const row of result.rows) this.storage.insertRow(o, n, row as StorageRow);
    meta.lastRefresh = new Date();
    meta.staleness = 'FRESH';
  }

  /** Base tables a SELECT reads — FROM list, JOINs, CTEs, FROM-subqueries. */
  private collectBaseTables(query: SelectStatement): { schema: string; table: string }[] {
    const out = new Map<string, { schema: string; table: string }>();
    const visit = (q: SelectStatement): void => {
      const refs = [...(q.from ?? []), ...(q.joins ?? []).map(j => j.table)];
      for (const ref of refs) {
        if (ref.type === 'TableRef') {
          const schema = (ref.schema ?? this.context.currentSchema).toUpperCase();
          const table = ref.name.toUpperCase();
          out.set(`${schema}.${table}`, { schema, table });
        } else if (ref.type === 'SubqueryTableRef') {
          visit(ref.query);
        }
      }
      for (const cte of q.withClause?.ctes ?? []) visit(cte.query);
    };
    visit(query);
    return [...out.values()];
  }

  private executeCreateTable(stmt: CreateTableStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const tableName = stmt.name.toUpperCase();

    // Creating in own schema needs CREATE TABLE; creating in another schema needs CREATE ANY TABLE.
    if (schema === this.context.currentUser) {
      this.privileges.requireSystemPrivilege('CREATE TABLE', 'CREATE ANY TABLE');
    } else {
      this.privileges.requireSystemPrivilege('CREATE ANY TABLE');
    }

    if (this.storage.tableExists(schema, tableName)) {
      throw new OracleError(955, `name is already used by an existing object`);
    }

    // CREATE TABLE AS SELECT (CTAS)
    if (stmt.asSelect) {
      const selectResult = this.executeSelect(stmt.asSelect);
      const columns: StorageColMeta[] = selectResult.columns.map((col, i) => ({
        name: col.name,
        dataType: col.dataType,
        ordinalPosition: i,
      }));
      this.storage.ensureSchema(schema);
      this.storage.createTable({
        schema, name: tableName, columns, constraints: [],
        tablespace: stmt.tablespace?.toUpperCase() || 'USERS',
        temporary: stmt.temporary,
        rowCount: 0,
      });
      for (const row of selectResult.rows) {
        this.storage.insertRow(schema, tableName, row as StorageRow);
      }
      return emptyResult('Table created.');
    }

    const columns: StorageColMeta[] = stmt.columns.map((col, i) => ({
      name: col.name.toUpperCase(),
      dataType: parseOracleType(col.dataType.name, col.dataType.precision, col.dataType.scale),
      ordinalPosition: i,
    }));

    const constraints: ConstraintMeta[] = [];
    const nextSysC = () => `SYS_C${String(10000 + this.instance.nextSysConstraintId()).padStart(6, '0')}`;

    // Column-level constraints
    for (const col of stmt.columns) {
      for (const cc of col.constraints) {
        // Unquoted identifiers are uppercase in the dictionary.
        const name = (cc.constraintName || nextSysC()).toUpperCase();
        if (cc.constraintType === 'CHECK' && cc.checkExpr) {
          constraints.push({
            name, type: 'CHECK', columns: [col.name.toUpperCase()],
            checkExpression: this.serializeExpr(cc.checkExpr),
          });
        } else if (cc.constraintType === 'NOT_NULL') {
          constraints.push({ name, type: 'NOT_NULL', columns: [col.name.toUpperCase()] });
          const colMeta = columns.find(c => c.name === col.name.toUpperCase());
          if (colMeta) colMeta.dataType = { ...colMeta.dataType, nullable: false };
        } else if (cc.constraintType === 'PRIMARY_KEY') {
          constraints.push({ name, type: 'PRIMARY_KEY', columns: [col.name.toUpperCase()] });
          const colMeta = columns.find(c => c.name === col.name.toUpperCase());
          if (colMeta) colMeta.dataType = { ...colMeta.dataType, nullable: false };
        } else if (cc.constraintType === 'UNIQUE') {
          constraints.push({ name, type: 'UNIQUE', columns: [col.name.toUpperCase()] });
        } else if (cc.constraintType === 'REFERENCES') {
          constraints.push({ name, type: 'FOREIGN_KEY', columns: [col.name.toUpperCase()], refTable: cc.refTable?.toUpperCase(), refColumns: cc.refColumn ? [cc.refColumn.toUpperCase()] : undefined, onDelete: cc.onDelete });
        }
      }
    }

    // Table-level constraints
    for (const tc of stmt.constraints) {
      const name = (tc.constraintName || nextSysC()).toUpperCase();
      constraints.push({
        name,
        type: tc.constraintType === 'PRIMARY_KEY' ? 'PRIMARY_KEY' : tc.constraintType === 'UNIQUE' ? 'UNIQUE' : tc.constraintType === 'FOREIGN_KEY' ? 'FOREIGN_KEY' : 'CHECK',
        columns: tc.columns.map(c => c.toUpperCase()),
        refTable: tc.refTable?.toUpperCase(),
        refColumns: tc.refColumns?.map(c => c.toUpperCase()),
        onDelete: tc.onDelete,
        checkExpression: tc.checkExpr ? this.serializeExpr(tc.checkExpr) : undefined,
      });
    }

    this.storage.ensureSchema(schema);
    this.storage.createTable({
      schema, name: tableName, columns, constraints,
      tablespace: stmt.tablespace?.toUpperCase() || 'USERS',
      temporary: stmt.temporary,
      rowCount: 0,
      partitioning: stmt.partitioning ? {
        type: stmt.partitioning.strategy === 'REFERENCE' ? 'REFERENCE'
            : stmt.partitioning.strategy === 'SYSTEM' ? 'SYSTEM'
            : stmt.partitioning.strategy,
        columns: stmt.partitioning.columns.map(c => c.toUpperCase()),
        interval: stmt.partitioning.interval,
        partitions: stmt.partitioning.partitions.map(p => ({
          name: p.name.toUpperCase(),
          highValue: p.highValue,
          tablespace: p.tablespace?.toUpperCase(),
        })),
      } : undefined,
    });

    // Real Oracle auto-creates a UNIQUE index for every PRIMARY KEY
    // and UNIQUE constraint. The index name defaults to the constraint
    // name (a SYS_C…-prefixed identifier when the DBA didn't name it).
    // The index sits in the same tablespace as the table.
    for (const c of constraints) {
      if (c.type === 'PRIMARY_KEY' || c.type === 'UNIQUE') {
        if (this.storage.getIndexes(schema).some(i => i.name === c.name)) continue;
        this.storage.createIndex(schema, {
          name: c.name,
          tableName,
          columns: c.columns,
          unique: true,
          tablespace: stmt.tablespace?.toUpperCase() || 'USERS',
        });
      }
    }

    return emptyResult('Table created.');
  }

  private executeDropTable(stmt: DropTableStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const tableName = stmt.name.toUpperCase();

    // Cross-schema drop requires DROP ANY TABLE; own-schema needs no extra priv.
    this.privileges.requireSchemaOrAnyPrivilege(schema, 'DROP ANY TABLE');

    if (!this.storage.tableExists(schema, tableName)) {
      if (stmt.ifExists) return emptyResult('');
      throw new OracleError(942, `table or view does not exist`);
    }

    // Unless PURGE is specified, soft-drop into the recyclebin so
    // FLASHBACK TABLE … TO BEFORE DROP can restore it.
    if (!stmt.purge) {
      const meta = this.storage.getTableMeta(schema, tableName)!;
      const rows = this.storage.getRows(schema, tableName);
      const catalog = this.catalog as OracleCatalog;
      catalog.recyclebinAdd({
        owner: schema,
        originalName: tableName,
        type: 'TABLE',
        tsName: meta.tablespace ?? 'USERS',
        space: Math.ceil((rows.length * 200) / 512),
        payload: { meta, rows },
      });
    }
    this.storage.dropTable(schema, tableName);
    return emptyResult('Table dropped.');
  }

  private executeTruncate(stmt: TruncateTableStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    this.storage.truncateTable(schema, stmt.name.toUpperCase());
    return emptyResult('Table truncated.');
  }

  private executeAlterTable(stmt: AlterTableStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const tableName = stmt.name.toUpperCase();
    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, `table or view does not exist`);
    }

    for (const action of stmt.actions) {
      if (action.action === 'ADD_COLUMN') {
        const col = action.column;
        this.storage.addColumn(schema, tableName, {
          name: col.name.toUpperCase(),
          dataType: parseOracleType(col.dataType.name, col.dataType.precision, col.dataType.scale),
          ordinalPosition: this.storage.getTableMeta(schema, tableName)!.columns.length,
        });
      } else if (action.action === 'MODIFY_COLUMN') {
        const col = action.column;
        const meta = this.storage.getTableMeta(schema, tableName);
        if (!meta) throw new OracleError(942, `table or view does not exist`);
        const existing = meta.columns.find(c => c.name === col.name.toUpperCase());
        if (!existing) throw new OracleError(904, `"${col.name.toUpperCase()}": invalid identifier`);
        // Update data type
        existing.dataType = parseOracleType(col.dataType.name, col.dataType.precision, col.dataType.scale);
        // Apply NOT NULL from constraints
        for (const cc of col.constraints) {
          if (cc.constraintType === 'NOT_NULL') {
            existing.dataType = { ...existing.dataType, nullable: false };
          }
        }
      } else if (action.action === 'ENCRYPT_COLUMN') {
        // Validate that the column exists, then record TDE metadata.
        const meta = this.storage.getTableMeta(schema, tableName);
        if (!meta) throw new OracleError(942, `table or view does not exist`);
        const col = meta.columns.find(c => c.name === action.columnName.toUpperCase());
        if (!col) throw new OracleError(904, `"${action.columnName.toUpperCase()}": invalid identifier`);
        (this.catalog as OracleCatalog).setColumnEncryption(
          schema, tableName, action.columnName,
          (action.algorithm ?? 'AES192').toUpperCase().replace(/^'|'$/g, ''),
          action.salt ?? true,
          (action.integrity ?? 'SHA-1').toUpperCase().replace(/^'|'$/g, ''),
        );
      } else if (action.action === 'DECRYPT_COLUMN') {
        (this.catalog as OracleCatalog).clearColumnEncryption(schema, tableName, action.columnName);
      } else if (action.action === 'DROP_COLUMN') {
        this.storage.dropColumn(schema, tableName, action.columnName.toUpperCase());
      } else if (action.action === 'RENAME_COLUMN') {
        const meta = this.storage.getTableMeta(schema, tableName);
        if (!meta) throw new OracleError(942, `table or view does not exist`);
        const oldUpper = action.oldName.toUpperCase();
        const newUpper = action.newName.toUpperCase();
        const target = meta.columns.find(c => c.name === oldUpper);
        if (!target) throw new OracleError(904, `"${oldUpper}": invalid identifier`);
        if (meta.columns.some(c => c.name === newUpper)) {
          throw new OracleError(957, 'duplicate column name');
        }
        target.name = newUpper;
        // Migrate stored row keys when rows are dict-keyed.
        const rows = this.storage.getRows?.(schema, tableName) ?? [];
        for (const row of rows) {
          if (row && Object.prototype.hasOwnProperty.call(row, oldUpper)) {
            (row as Record<string, unknown>)[newUpper] = (row as Record<string, unknown>)[oldUpper];
            delete (row as Record<string, unknown>)[oldUpper];
          }
        }
      } else if (action.action === 'RENAME_TABLE') {
        const meta = this.storage.getTableMeta(schema, tableName);
        if (!meta) throw new OracleError(942, `table or view does not exist`);
        const newUpper = action.newName.toUpperCase();
        if (this.storage.getTableMeta(schema, newUpper)) {
          throw new OracleError(955, 'name is already used by an existing object');
        }
        meta.name = newUpper;
      } else if (action.action === 'MOVE_TABLESPACE') {
        const meta = this.storage.getTableMeta(schema, tableName);
        if (!meta) throw new OracleError(942, `table or view does not exist`);
        const target = action.tablespace.toUpperCase();
        if (target && !(this.storage as OracleStorage).tablespaceExists(target)) {
          throw new OracleError(959, `tablespace '${target}' does not exist`);
        }
        if (target) meta.tablespace = target;
      } else if (action.action === 'MOVE_COMPRESS') {
        const meta = this.storage.getTableMeta(schema, tableName);
        if (meta) {
          const level = action.compressionLevel?.trim().toUpperCase();
          // `NOCOMPRESS` / empty / OFF → disabled. Anything else → enabled.
          const off = !level || level === 'OFF' || level.startsWith('NOCOMPRESS');
          meta.compression = off
            ? { enabled: false }
            : { enabled: true, for: level.replace(/^FOR\s+/i, '').trim() || 'BASIC' };
        }
      } else if (action.action === 'SHRINK_SPACE' || action.action === 'ROW_MOVEMENT') {
        // No persisted state changes in the simulator; the operation
        // succeeds the same way it does on a real instance with no rows.
      } else if (action.action === 'ADD_SUPPLEMENTAL_LOG_GROUP') {
        (this.catalog as OracleCatalog).addSupplementalLogGroup({
          owner: schema,
          logGroupName: action.logGroupName.toUpperCase(),
          tableName,
          always: action.always,
          columns: action.columns.map(c => c.toUpperCase()),
        });
      } else if (action.action === 'DROP_SUPPLEMENTAL_LOG_GROUP') {
        (this.catalog as OracleCatalog).dropSupplementalLogGroup(schema, action.logGroupName);
      } else if (action.action === 'ADD_SUPPLEMENTAL_LOG_DATA') {
        // Toggle on the instance-level supplemental log flags so
        // V\$DATABASE reflects it.
        const inst = this.instance;
        const supp = inst.supplementalLog;
        switch (action.mode) {
          case 'PRIMARY_KEY': inst.setSupplementalLog({ min: 'IMPLICIT', pk: true }); break;
          case 'UNIQUE':      inst.setSupplementalLog({ min: 'IMPLICIT', ui: true }); break;
          case 'FOREIGN_KEY': inst.setSupplementalLog({ min: 'IMPLICIT', fk: true }); break;
          case 'ALL':         inst.setSupplementalLog({ min: 'IMPLICIT', all: true, pk: supp.pk, ui: supp.ui, fk: supp.fk }); break;
        }
      } else if (
        action.action === 'FLASHBACK_ARCHIVE' || action.action === 'NO_FLASHBACK_ARCHIVE'
        || action.action === 'INMEMORY' || action.action === 'NO_INMEMORY'
      ) {
        this.requireCommandHost().execAlterTableStorage(schema, tableName, action);
      }
    }

    return emptyResult('Table altered.');
  }

  private executeCreateIndex(stmt: CreateIndexStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const indexName = stmt.name.toUpperCase();
    const tableName = stmt.table.toUpperCase();
    if (!this.storage.tableExists(schema, tableName)) {
      throw new OracleError(942, 'table or view does not exist');
    }
    if (this.storage.getIndexes(schema).some(i => i.name === indexName)) {
      throw new OracleError(955, 'name is already used by an existing object');
    }
    const meta = this.storage.getTableMeta(schema, tableName)!;
    const tableCols = new Set(meta.columns.map(c => c.name.toUpperCase()));
    for (const c of stmt.columns) {
      if (!c.expression && !tableCols.has(c.name.toUpperCase())) {
        throw new OracleError(904, `"${c.name.toUpperCase()}": invalid identifier`);
      }
    }
    const expressions = stmt.columns.map(c => c.expression ? c.expression.toUpperCase() : null);
    const hasExpressions = expressions.some(e => e !== null);
    if (stmt.unique && !hasExpressions) {
      // ORA-01452: a unique index cannot be built over duplicate keys.
      // Entirely-NULL keys are not indexed by Oracle, so they never collide.
      const colIdx = stmt.columns.map(c =>
        meta.columns.findIndex(mc => mc.name.toUpperCase() === c.name.toUpperCase()));
      const seen = new Set<string>();
      for (const row of this.storage.getRows(schema, tableName)) {
        const values = colIdx.map(i => row[i] ?? null);
        if (values.every(v => v === null)) continue;
        const key = JSON.stringify(values);
        if (seen.has(key)) {
          throw new OracleError(1452, 'cannot CREATE UNIQUE INDEX; duplicate keys found');
        }
        seen.add(key);
      }
    }
    this.storage.createIndex(schema, {
      name: indexName,
      tableName,
      columns: stmt.columns.map(c => c.name.toUpperCase()),
      unique: !!stmt.unique,
      bitmap: stmt.bitmap,
      ...(hasExpressions ? { expressions } : {}),
    });
    return emptyResult('Index created.');
  }

  private executeDropIndex(stmt: DropIndexStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const indexName = stmt.name.toUpperCase();
    if (!this.storage.getIndexes(schema).some(i => i.name === indexName)) {
      throw new OracleError(1418, 'specified index does not exist');
    }
    this.storage.dropIndex(schema, indexName);
    return emptyResult('Index dropped.');
  }

  private executeCreateSequence(stmt: CreateSequenceStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    this.storage.createSequence(schema, {
      name: stmt.name.toUpperCase(),
      currentValue: (stmt.startWith ?? 1) - (stmt.incrementBy ?? 1),
      incrementBy: stmt.incrementBy ?? 1,
      minValue: 1,
      maxValue: stmt.maxValue === 'NOMAXVALUE' ? Number.MAX_SAFE_INTEGER : (typeof stmt.maxValue === 'number' ? stmt.maxValue : 999999999),
      cache: stmt.cache === 'NOCACHE' ? 0 : (typeof stmt.cache === 'number' ? stmt.cache : 20),
      cycle: stmt.cycle ?? false,
    });
    return emptyResult('Sequence created.');
  }

  private executeDropSequence(stmt: DropSequenceStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    if (!this.storage.sequenceExists(schema, name)) {
      throw new OracleError(2289, 'sequence does not exist');
    }
    this.storage.dropSequence(schema, name);
    return emptyResult('Sequence dropped.');
  }

  // ── View DDL ─────────────────────────────────────────────────────

  private executeCreateView(stmt: CreateViewStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    // For OR REPLACE, drop existing view first
    if (stmt.orReplace && this.storage.viewExists(schema, name)) {
      this.storage.dropView(schema, name);
    }
    // Reconstruct the query text from the AST by re-serializing the SELECT
    // We store the original query text for DBA_VIEWS
    const queryText = this.serializeSelect(stmt.query);
    this.storage.createView({
      schema, name,
      columns: stmt.columns,
      queryText,
      queryAST: stmt.query,
      withCheckOption: stmt.withCheckOption,
      withReadOnly: stmt.withReadOnly,
    });
    return emptyResult('View created.');
  }

  private executeDropView(stmt: DropViewStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    if (!this.storage.viewExists(schema, name)) {
      throw new OracleError(942, 'table or view does not exist');
    }
    this.storage.dropView(schema, name);
    return emptyResult('View dropped.');
  }

  private serializeSelect(stmt: SelectStatement): string {
    // Minimal serialization for view storage — enough to re-parse later
    const parts: string[] = ['SELECT'];
    if (stmt.distinct) parts.push('DISTINCT');
    parts.push(stmt.columns.map(c => {
      const exprStr = this.serializeExpr(c.expr);
      return c.alias ? `${exprStr} AS ${c.alias}` : exprStr;
    }).join(', '));
    if (stmt.from && stmt.from.length > 0) {
      parts.push('FROM');
      parts.push(stmt.from.map(f => {
        if (f.type === 'TableRef') {
          const ref = f.schema ? `${f.schema}.${f.name}` : f.name;
          return f.alias ? `${ref} ${f.alias}` : ref;
        }
        return '(subquery)';
      }).join(', '));
    }
    if (stmt.where) parts.push('WHERE', this.serializeExpr(stmt.where));
    return parts.join(' ');
  }

  private serializeExpr(expr: Expression): string {
    switch (expr.type) {
      case 'Identifier': return (expr as IdentifierExpr).qualifier
        ? `${(expr as IdentifierExpr).qualifier}.${(expr as IdentifierExpr).name}`
        : (expr as IdentifierExpr).name;
      case 'Literal': {
        const lit = expr as LiteralExpr;
        return typeof lit.value === 'string' ? `'${lit.value}'` : String(lit.value ?? 'NULL');
      }
      case 'Star': return '*';
      case 'BinaryExpr': {
        const bin = expr as BinaryExpr;
        return `${this.serializeExpr(bin.left)} ${bin.operator} ${this.serializeExpr(bin.right)}`;
      }
      case 'FunctionCall': {
        const fn = expr as FunctionCallExpr;
        return `${fn.name}(${fn.args.map(a => this.serializeExpr(a)).join(', ')})`;
      }
      case 'ParenExpr':
        return `(${this.serializeExpr(expr.expr)})`;
      case 'UnaryExpr':
        return expr.operator === 'NOT'
          ? `NOT (${this.serializeExpr(expr.operand)})`
          : `${expr.operator}${this.serializeExpr(expr.operand)}`;
      case 'IsNullExpr':
        return `${this.serializeExpr(expr.expr)} IS${expr.negated ? ' NOT' : ''} NULL`;
      case 'InExpr': {
        if (!Array.isArray(expr.values)) return '?';
        const list = expr.values.map(v => this.serializeExpr(v)).join(', ');
        return `${this.serializeExpr(expr.expr)}${expr.negated ? ' NOT' : ''} IN (${list})`;
      }
      case 'BetweenExpr':
        return `${this.serializeExpr(expr.expr)}${expr.negated ? ' NOT' : ''} BETWEEN `
          + `${this.serializeExpr(expr.low)} AND ${this.serializeExpr(expr.high)}`;
      case 'LikeExpr':
        return `${this.serializeExpr(expr.expr)}${expr.negated ? ' NOT' : ''} LIKE `
          + this.serializeExpr(expr.pattern);
      default: return '?';
    }
  }

  // ── EXPLAIN PLAN ─────────────────────────────────────────────────

  private executeExplainPlan(stmt: ExplainPlanStatement): ResultSet {
    const innerStmt = stmt.statement;
    const columns: ColumnMeta[] = [
      { name: 'ID', dataType: 'NUMBER' },
      { name: 'OPERATION', dataType: 'VARCHAR2' },
      { name: 'NAME', dataType: 'VARCHAR2' },
      { name: 'ROWS', dataType: 'NUMBER' },
      { name: 'BYTES', dataType: 'NUMBER' },
      { name: 'COST', dataType: 'NUMBER' },
    ];

    const db = (this as { _db?: { planGenerator: import('./plan/PlanGenerator').PlanGenerator } })._db;
    if (db) {
      const plan = db.planGenerator.generate(innerStmt, '0', '', this.context.currentSchema);
      const rows: Row[] = plan.nodes.map(n => [
        n.id,
        n.options ? `${n.operation} ${n.options}` : n.operation,
        n.objectName ?? '',
        n.cardinality,
        n.bytes,
        n.cost,
      ]);
      return { columns, rows, rowCount: rows.length, message: 'Explained.' };
    }

    const plan: Array<{ id: number; operation: string; name: string; rows: number; bytes: number; cost: number }> = [];
    let nextId = 0;
    const addStep = (operation: string, name: string, rows: number, cost: number) => {
      plan.push({ id: nextId++, operation, name, rows, bytes: rows * 100, cost });
    };

    if (innerStmt.type === 'SelectStatement') {
      const select = innerStmt as SelectStatement;
      if (select.from && select.from.length > 0) {
        const tableName = select.from[0].type === 'TableRef' ? select.from[0].name : 'SUBQUERY';
        const schema = (select.from[0].type === 'TableRef' ? select.from[0].schema : null) || this.context.currentSchema;
        let estimatedRows = 1000;
        const meta = this.storage.getTableMeta(schema.toUpperCase(), tableName.toUpperCase());
        if (meta) estimatedRows = meta.rowCount || 1;
        addStep('SELECT STATEMENT', '', estimatedRows, estimatedRows);
        if (select.orderBy && select.orderBy.length > 0) addStep('SORT ORDER BY', '', estimatedRows, estimatedRows + 1);
        if (select.groupBy && select.groupBy.length > 0) addStep('HASH GROUP BY', '', Math.ceil(estimatedRows / 10), Math.ceil(estimatedRows / 10));
        addStep('TABLE ACCESS FULL', tableName.toUpperCase(), estimatedRows, estimatedRows);
        if (select.joins) {
          for (const join of select.joins) {
            const rightTable = join.table.type === 'TableRef' ? join.table.name.toUpperCase() : 'SUBQUERY';
            addStep('HASH JOIN', '', estimatedRows * 2, estimatedRows * 2);
            addStep('TABLE ACCESS FULL', rightTable, estimatedRows, estimatedRows);
          }
        }
      }
    } else if (innerStmt.type === 'InsertStatement') {
      const ins = innerStmt as InsertStatement;
      addStep('INSERT STATEMENT', '', 1, 1);
      addStep('LOAD TABLE CONVENTIONAL', ins.table.name.toUpperCase(), 1, 1);
    } else if (innerStmt.type === 'UpdateStatement') {
      const upd = innerStmt as UpdateStatement;
      addStep('UPDATE STATEMENT', '', 1, 1);
      addStep('UPDATE', upd.table.name.toUpperCase(), 1, 1);
      addStep('TABLE ACCESS FULL', upd.table.name.toUpperCase(), 1, 1);
    } else if (innerStmt.type === 'DeleteStatement') {
      const del = innerStmt as DeleteStatement;
      addStep('DELETE STATEMENT', '', 1, 1);
      addStep('DELETE', del.table.name.toUpperCase(), 1, 1);
      addStep('TABLE ACCESS FULL', del.table.name.toUpperCase(), 1, 1);
    }

    const rows: Row[] = plan.map(p => [p.id, p.operation, p.name, p.rows, p.bytes, p.cost]);
    return { columns, rows, rowCount: rows.length, message: 'Explained.' };
  }

  // ── Triggers ─────────────────────────────────────────────────────

  private executeCreateTrigger(stmt: CreateTriggerStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    const tableSchema = this.resolveSchema(stmt.tableSchema);

    if (stmt.orReplace) {
      try { this.storage.dropTrigger(schema, name); } catch { /* ignore if not exists */ }
    }

    this.storage.createTrigger({
      schema, name,
      timing: stmt.timing,
      events: stmt.events,
      tableName: stmt.tableName.toUpperCase(),
      tableSchema,
      forEachRow: stmt.forEachRow || false,
      whenCondition: stmt.whenCondition,
      body: stmt.body,
      enabled: true,
    });

    return emptyResult('Trigger created.');
  }

  private executeDropTrigger(stmt: DropTriggerStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    const exists = this.storage.getAllTriggers()
      .some(t => t.schema === schema && t.name === name);
    if (!exists) {
      throw new OracleError(4080, `trigger '${name}' does not exist`);
    }
    this.storage.dropTrigger(schema, name);
    return emptyResult('Trigger dropped.');
  }

  fireTriggers(schema: string, tableName: string, event: 'INSERT' | 'UPDATE' | 'DELETE', timing: 'BEFORE' | 'AFTER'): void {
    const triggers = this.storage.getTriggersForTable(schema, tableName);
    for (const trigger of triggers) {
      if (trigger.timing === timing && trigger.events.includes(event)) {
        // Execute the trigger body as a PL/SQL block if it contains executable SQL
        // For the simulator, we just log that the trigger fired
        // A full implementation would parse and execute the body
      }
    }
  }

  // ── SYNONYM ────────────────────────────────────────────────────────

  private executeCreateSynonym(stmt: CreateSynonymStatement): ResultSet {
    const owner = stmt.isPublic ? 'PUBLIC' : this.resolveSchema(stmt.schema);
    const targetSchema = this.resolveSchema(stmt.targetSchema);
    this.storage.createSynonym({
      owner,
      name: stmt.name.toUpperCase(),
      tableOwner: targetSchema,
      tableName: stmt.targetName.toUpperCase(),
      isPublic: !!stmt.isPublic,
    });
    return emptyResult('Synonym created.');
  }

  private executeDropSynonym(stmt: DropSynonymStatement): ResultSet {
    const owner = stmt.isPublic ? 'PUBLIC' : this.resolveSchema(stmt.schema);
    const name = stmt.name.toUpperCase();
    if (!this.storage.getSynonym(owner, name)) {
      throw stmt.isPublic
        ? new OracleError(1432, 'public synonym to be dropped does not exist')
        : new OracleError(1434, 'private synonym to be dropped does not exist');
    }
    this.storage.dropSynonym(owner, name);
    return emptyResult('Synonym dropped.');
  }

  // ── ALTER SEQUENCE ────────────────────────────────────────────────

  private executeAlterSequence(stmt: AlterSequenceStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    const seq = this.storage.getSequence(schema, stmt.name.toUpperCase());
    if (!seq) throw new OracleError(2289, `sequence ${stmt.name} does not exist`);
    if (stmt.incrementBy !== undefined) seq.incrementBy = stmt.incrementBy;
    if (stmt.minValue !== undefined) seq.minValue = stmt.minValue;
    if (stmt.maxValue !== undefined) seq.maxValue = stmt.maxValue;
    if (stmt.cache !== undefined) seq.cache = stmt.cache;
    if (stmt.cycle !== undefined) seq.cycle = stmt.cycle;
    return emptyResult('Sequence altered.');
  }

  // ── ALTER INDEX ───────────────────────────────────────────────────

  private executeAlterIndex(stmt: AlterIndexStatement): ResultSet {
    const schema = this.resolveSchema(stmt.schema);
    if (stmt.action === 'REBUILD') {
      // In a simulator, REBUILD is a no-op (the index is already in memory)
      const indexes = this.storage.getIndexes(schema);
      const idx = indexes.find(i => i.name === stmt.name.toUpperCase());
      if (!idx) throw new OracleError(1418, `specified index does not exist`);
      return emptyResult('Index altered.');
    }
    if (stmt.action === 'RENAME' && stmt.newName) {
      // Rename index — for simplicity, return success
      return emptyResult('Index altered.');
    }
    if (stmt.action === 'MONITORING_USAGE') {
      this.instance.getIndexUsageMonitor()?.beginMonitoring(schema, stmt.name);
      return emptyResult('Index altered.');
    }
    if (stmt.action === 'NOMONITORING_USAGE') {
      this.instance.getIndexUsageMonitor()?.endMonitoringFor(schema, stmt.name);
      return emptyResult('Index altered.');
    }
    throw new OracleError(900, `Unsupported ALTER INDEX action: ${stmt.action}`);
  }

  // ── DCL ───────────────────────────────────────────────────────────

  /** Resolve the grantee list shared by GRANT and REVOKE statements. */
  // ── User/Role management ──────────────────────────────────────────

  // ── Instance commands ─────────────────────────────────────────────

  // ── Expression evaluation ─────────────────────────────────────────

  evaluateExpression(expr: Expression, row: StorageRow, columns: StorageColMeta[]): CellValue {
    switch (expr.type) {
      case 'Literal':
        if (expr.dataType === 'null') return null;
        if (expr.dataType === 'number') return Number(expr.value);
        if (expr.dataType === 'date' || expr.dataType === 'timestamp') return new Date(String(expr.value));
        return String(expr.value ?? '');

      case 'Identifier': {
        const colIdx = this.resolveColumnIndex(expr, columns);
        if (colIdx >= 0 && colIdx < row.length) return row[colIdx];
        // Handle schema.sequence.NEXTVAL / CURRVAL (three-part identifier)
        const idName = expr.name.toUpperCase();
        const idTable = (expr as IdentifierExpr).table?.toUpperCase();
        const idSchema = (expr as IdentifierExpr).schema?.toUpperCase();
        if ((idName === 'NEXTVAL' || idName === 'CURRVAL') && idTable) {
          const seqSchema = idSchema || this.context.currentSchema;
          return idName === 'NEXTVAL'
            ? this.sequenceNextVal(seqSchema, idTable)
            : this.sequenceCurrVal(seqSchema, idTable);
        }
        // DBMS_RANDOM.VALUE / DBMS_RANDOM.NORMAL (no-parens access)
        const pkgName = idTable;
        if (pkgName === 'DBMS_RANDOM') {
          const fn = expr.name.toUpperCase();
          if (fn === 'VALUE') return Math.random();
          if (fn === 'NORMAL') {
            const u1 = Math.random(), u2 = Math.random();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          }
        }
        // DBMS_UTILITY (no-parens access)
        if (pkgName === 'DBMS_UTILITY') {
          const fn = expr.name.toUpperCase();
          if (fn === 'GET_TIME') return Date.now() % 2147483647;
          if (fn === 'FORMAT_ERROR_BACKTRACE' || fn === 'FORMAT_ERROR_STACK') return '';
        }
        // DBMS_LOB (no-parens access)
        if (pkgName === 'DBMS_LOB') {
          const fn = expr.name.toUpperCase();
          if (fn === 'GETLENGTH') return null;
        }
        // Oracle pseudo-columns
        if (idName === 'SYSDATE' || idName === 'CURRENT_DATE') return new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (idName === 'SYSTIMESTAMP' || idName === 'CURRENT_TIMESTAMP') return new Date().toISOString();
        if (idName === 'USER') return this.context.currentUser;
        if (idName === 'ROWNUM') return this._currentRowNum || 1;
        // ORA-00904: invalid identifier — mirrors real Oracle behavior
        if (columns.length > 0) {
          const displayName = pkgName ? `${pkgName}.${idName}` : idName;
          throw new OracleError(904, `"${displayName}": invalid identifier`);
        }
        return null;
      }

      case 'Star': return null;

      case 'BinaryExpr': {
        const left = this.evaluateExpression(expr.left, row, columns);
        const right = this.evaluateExpression(expr.right, row, columns);
        return this.applyBinaryOp(expr.operator, left, right);
      }

      case 'UnaryExpr': {
        if (expr.operator === 'EXISTS' || expr.operator === 'NOT EXISTS') {
          // EXISTS handled in evaluateCondition, return boolean-ish value here
          const subExpr = expr.operand;
          if (subExpr.type === 'SubqueryExpr') {
            const subResult = this.executeSubquery(subExpr.query, row, columns);
            const exists = subResult.rows.length > 0;
            return expr.operator === 'NOT EXISTS' ? !exists : exists;
          }
          return null;
        }
        const operand = this.evaluateExpression(expr.operand, row, columns);
        if (expr.operator === '-') return typeof operand === 'number' ? -operand : null;
        if (expr.operator === '+') return operand;
        if (expr.operator === 'NOT') return operand ? false : true;
        return null;
      }

      case 'SubqueryExpr': {
        // Scalar subquery — execute and return single value
        const subResult = this.executeSubquery(expr.query, row, columns);
        if (subResult.rows.length === 0) return null;
        return subResult.rows[0][0];
      }

      case 'FunctionCall':
        return this.evaluateFunction(expr, row, columns);

      case 'CaseExpr':
        return this.evaluateCase(expr, row, columns);

      case 'ParenExpr':
        return this.evaluateExpression(expr.expr, row, columns);

      case 'SequenceExpr': {
        const seqSchema = expr.schema || this.context.currentSchema;
        return expr.operation === 'NEXTVAL'
          ? this.sequenceNextVal(seqSchema, expr.sequenceName)
          : this.sequenceCurrVal(seqSchema, expr.sequenceName);
      }

      default:
        return null;
    }
  }

  /** NEXTVAL: advance the global counter, remember the value per session. */
  private sequenceNextVal(schema: string, name: string): number {
    const s = schema.toUpperCase();
    const n = name.toUpperCase();
    if (!this.storage.sequenceExists(s, n)) {
      throw new OracleError(2289, 'sequence does not exist');
    }
    const val = this.storage.nextVal(s, n) as number;
    this._sessionCurrval.set(`${s}.${n}`, val);
    return val;
  }

  /** CURRVAL: the last NEXTVAL of THIS session — never the global counter
   *  (ORA-08002 before the first NEXTVAL, ORA-02289 if dropped). */
  private sequenceCurrVal(schema: string, name: string): number {
    const s = schema.toUpperCase();
    const n = name.toUpperCase();
    if (!this.storage.sequenceExists(s, n)) {
      throw new OracleError(2289, 'sequence does not exist');
    }
    const val = this._sessionCurrval.get(`${s}.${n}`);
    if (val === undefined) {
      throw new OracleError(8002, `sequence ${n}.CURRVAL is not yet defined in this session`);
    }
    return val;
  }

  /** WHERE / JOIN-ON boundary: only a TRUE predicate passes — UNKNOWN
   *  filters the row out exactly like FALSE (SQL three-valued logic). */
  private evaluateCondition(expr: Expression, row: StorageRow, columns: StorageColMeta[]): boolean {
    return this.evaluateCondition3VL(expr, row, columns) === true;
  }

  /**
   * SQL three-valued logic (Kleene): a condition is TRUE, FALSE or
   * UNKNOWN (represented as null). NULL operands make comparisons,
   * LIKE, BETWEEN and IN evaluate to UNKNOWN; AND/OR combine per the
   * standard truth tables and NOT UNKNOWN stays UNKNOWN. CHECK
   * constraints accept TRUE *and* UNKNOWN (see ConstraintValidator
   * wiring), while WHERE keeps only TRUE.
   */
  private evaluateCondition3VL(expr: Expression, row: StorageRow, columns: StorageColMeta[]): boolean | null {
    const not3 = (v: boolean | null): boolean | null => (v === null ? null : !v);
    switch (expr.type) {
      case 'BinaryExpr': {
        if (expr.operator === 'AND') {
          const l = this.evaluateCondition3VL(expr.left, row, columns);
          if (l === false) return false;
          const r = this.evaluateCondition3VL(expr.right, row, columns);
          if (r === false) return false;
          return l === null || r === null ? null : true;
        }
        if (expr.operator === 'OR') {
          const l = this.evaluateCondition3VL(expr.left, row, columns);
          if (l === true) return true;
          const r = this.evaluateCondition3VL(expr.right, row, columns);
          if (r === true) return true;
          return l === null || r === null ? null : false;
        }
        const left = this.evaluateExpression(expr.left, row, columns);
        const right = this.evaluateExpression(expr.right, row, columns);
        if (left === null || right === null) return null;
        return this.applyComparison(expr.operator, left, right);
      }
      case 'UnaryExpr':
        if (expr.operator === 'NOT') {
          return not3(this.evaluateCondition3VL(expr.operand, row, columns));
        }
        if (expr.operator === 'EXISTS') {
          if (expr.operand.type === 'SubqueryExpr') {
            const subResult = this.executeSubquery((expr.operand as SubqueryExpr).query, row, columns);
            return subResult.rows.length > 0;
          }
          return false;
        }
        if (expr.operator === 'NOT EXISTS') {
          if (expr.operand.type === 'SubqueryExpr') {
            const subResult = this.executeSubquery((expr.operand as SubqueryExpr).query, row, columns);
            return subResult.rows.length === 0;
          }
          return true;
        }
        return !!this.evaluateExpression(expr, row, columns);
      case 'IsNullExpr': {
        const val = this.evaluateExpression(expr.expr, row, columns);
        return expr.negated ? val !== null : val === null;
      }
      case 'BetweenExpr': {
        // val BETWEEN low AND high == val >= low AND val <= high, in 3VL.
        const val = this.evaluateExpression(expr.expr, row, columns);
        const low = this.evaluateExpression(expr.low, row, columns);
        const high = this.evaluateExpression(expr.high, row, columns);
        const geLow: boolean | null =
          val === null || low === null ? null : this.compareValues(val, low) >= 0;
        const leHigh: boolean | null =
          val === null || high === null ? null : this.compareValues(val, high) <= 0;
        const inRange: boolean | null =
          geLow === false || leHigh === false ? false
            : geLow === null || leHigh === null ? null : true;
        return expr.negated ? not3(inRange) : inRange;
      }
      case 'InExpr': {
        // IN is a chain of OR'd equalities: a NULL on either side makes
        // that comparison UNKNOWN, so `x NOT IN (1, NULL)` never passes.
        const val = this.evaluateExpression(expr.expr, row, columns);
        const inList = (values: CellValue[]): boolean | null => {
          let sawUnknown = false;
          for (const ev of values) {
            if (val === null || ev === null) { sawUnknown = true; continue; }
            if (this.compareValues(val, ev) === 0) return true;
          }
          return sawUnknown ? null : false;
        };
        let res: boolean | null;
        if (Array.isArray(expr.values)) {
          res = inList(expr.values.map(v => this.evaluateExpression(v, row, columns)));
        } else {
          // Subquery IN — values is a SelectStatement
          const subStmt = expr.values as unknown as SelectStatement;
          const subResult = this.executeSubquery(subStmt, row, columns);
          res = inList(subResult.rows.map(r => r[0]));
        }
        return expr.negated ? not3(res) : res;
      }
      case 'LikeExpr': {
        const valRaw = this.evaluateExpression(expr.expr, row, columns);
        const patternRaw = this.evaluateExpression(expr.pattern, row, columns);
        const escapeRaw = expr.escape ? this.evaluateExpression(expr.escape, row, columns) : undefined;
        if (valRaw === null || patternRaw === null || escapeRaw === null) return null;
        const val = String(valRaw);
        const pattern = String(patternRaw);
        const escapeChar = escapeRaw !== undefined ? String(escapeRaw) : null;
        // Build regex: escape regex-special chars first, then replace SQL wildcards
        let regexStr = '';
        for (let pi = 0; pi < pattern.length; pi++) {
          const ch = pattern[pi];
          if (escapeChar && ch === escapeChar && pi + 1 < pattern.length) {
            // Next char is a literal
            regexStr += pattern[pi + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            pi++;
          } else if (ch === '%') {
            regexStr += '.*';
          } else if (ch === '_') {
            regexStr += '.';
          } else {
            regexStr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          }
        }
        // Oracle LIKE is case-sensitive (no 'i' flag).
        const regex = new RegExp('^' + regexStr + '$');
        const match = regex.test(val);
        return expr.negated ? !match : match;
      }
      case 'ParenExpr':
        return this.evaluateCondition3VL(expr.expr, row, columns);
      default: {
        const v = this.evaluateExpression(expr, row, columns);
        return v === null ? null : !!v;
      }
    }
  }

  /**
   * Execute a subquery in the context of an outer row (for correlated subqueries).
   * Replaces references to outer table aliases with values from the current row.
   */
  private executeSubquery(subStmt: SelectStatement, outerRow: StorageRow, outerColumns: StorageColMeta[]): ResultSet {
    // Create a patched version that falls back to outer row for unresolved identifiers
    const origMethod = this.evaluateExpression;
    this.evaluateExpression = (expr: Expression, row: StorageRow, columns: StorageColMeta[]): CellValue => {
      if (expr.type === 'Identifier') {
        // First try resolving in inner columns
        const innerIdx = this.resolveColumnIndex(expr, columns);
        if (innerIdx >= 0 && innerIdx < row.length) {
          return row[innerIdx];
        }
        // Then try outer columns (correlated reference)
        const outerIdx = this.resolveColumnIndex(expr, outerColumns);
        if (outerIdx >= 0 && outerIdx < outerRow.length) {
          return outerRow[outerIdx];
        }
        // DBMS_RANDOM without parens
        if ((expr as IdentifierExpr).table?.toUpperCase() === 'DBMS_RANDOM') {
          const fn = (expr as IdentifierExpr).name.toUpperCase();
          if (fn === 'VALUE') return Math.random();
          if (fn === 'NORMAL') {
            const u1 = Math.random(), u2 = Math.random();
            return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
          }
        }
        // Pseudo-columns
        const name = (expr as IdentifierExpr).name.toUpperCase();
        if (name === 'SYSDATE' || name === 'CURRENT_DATE') return new Date().toISOString().slice(0, 19).replace('T', ' ');
        if (name === 'SYSTIMESTAMP' || name === 'CURRENT_TIMESTAMP') return new Date().toISOString();
        if (name === 'USER') return this.context.currentUser;
        if (name === 'ROWNUM') return this._currentRowNum || 1;
        // ORA-00904: invalid identifier — mirrors real Oracle behavior
        if (columns.length > 0 || outerColumns.length > 0) {
          const tbl = (expr as IdentifierExpr).table?.toUpperCase();
          const displayName = tbl ? `${tbl}.${name}` : name;
          throw new OracleError(904, `"${displayName}": invalid identifier`);
        }
        return null;
      }
      return origMethod.call(this, expr, row, columns);
    };

    try {
      return this.executeSelect(subStmt);
    } finally {
      this.evaluateExpression = origMethod;
    }
  }

  /** Scalar SQL functions are evaluated by the dedicated module (SRP). */
  private evaluateFunction(expr: FunctionCallExpr, row: StorageRow, columns: StorageColMeta[]): CellValue {
    return this.scalarFunctions.evaluate(expr, row, columns);
  }

  private formatOracleDate(d: Date, fmt: string): string {
    const pad = (n: number, w: number = 2) => String(n).padStart(w, '0');
    const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
    const monthsShort = months.map(m => m.slice(0, 3));
    const days = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
    const daysShort = days.map(d => d.slice(0, 3));

    let result = fmt;
    // Order matters: longest tokens first to avoid partial replacement
    result = result.replace(/YYYY/g, String(d.getFullYear()));
    result = result.replace(/YY/g, String(d.getFullYear()).slice(-2));
    result = result.replace(/MONTH/g, months[d.getMonth()]);
    result = result.replace(/MON/g, monthsShort[d.getMonth()]);
    result = result.replace(/MM/g, pad(d.getMonth() + 1));
    result = result.replace(/DD/g, pad(d.getDate()));
    result = result.replace(/DAY/g, days[d.getDay()]);
    result = result.replace(/DY/g, daysShort[d.getDay()]);
    result = result.replace(/HH24/g, pad(d.getHours()));
    result = result.replace(/HH/g, pad(d.getHours() % 12 || 12));
    result = result.replace(/MI/g, pad(d.getMinutes()));
    result = result.replace(/SS/g, pad(d.getSeconds()));
    return result;
  }

  private parseOracleDate(dateStr: string, fmt: string): string {
    // Try ISO format first
    const isoDate = new Date(dateStr);
    if (!isNaN(isoDate.getTime())) {
      return isoDate.toISOString().slice(0, 19).replace('T', ' ');
    }
    // Simple format-aware parsing for common Oracle formats
    let year = 2000, month = 1, day = 1, hour = 0, min = 0, sec = 0;
    const fmtUpper = fmt.toUpperCase();
    const parts = dateStr.split(/[\s/\-:.,]+/);
    const fmtParts = fmtUpper.split(/[\s/\-:.,]+/);
    for (let i = 0; i < fmtParts.length && i < parts.length; i++) {
      const v = parseInt(parts[i], 10);
      if (isNaN(v) && fmtParts[i] === 'MON') {
        const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        const idx = months.indexOf(parts[i].toUpperCase().slice(0, 3));
        if (idx >= 0) month = idx + 1;
        continue;
      }
      if (isNaN(v)) continue;
      switch (fmtParts[i]) {
        case 'YYYY': year = v; break;
        case 'YY': year = 2000 + v; break;
        case 'MM': month = v; break;
        case 'DD': day = v; break;
        case 'HH24': case 'HH': hour = v; break;
        case 'MI': min = v; break;
        case 'SS': sec = v; break;
      }
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(min)}:${pad(sec)}`;
  }

  private getMetadataDDL(args: CellValue[]): CellValue {
    if (args.length < 2) return null;
    const objectType = String(args[0]).toUpperCase();
    const objectName = String(args[1]).toUpperCase();
    const schema = args.length >= 3 && args[2] ? String(args[2]).toUpperCase() : this.context.currentSchema;

    switch (objectType) {
      case 'TABLE': {
        const meta = this.storage.getTableMeta(schema, objectName);
        if (!meta) return null;
        const cols = meta.columns.map(c => {
          let def = `  ${c.name} ${c.dataType.name}`;
          if (c.dataType.precision != null) {
            def += c.dataType.scale != null && c.dataType.scale > 0
              ? `(${c.dataType.precision},${c.dataType.scale})`
              : `(${c.dataType.precision})`;
          }
          if (!c.dataType.nullable) def += ' NOT NULL';
          return def;
        }).join(',\n');
        return `CREATE TABLE ${schema}.${objectName} (\n${cols}\n)`;
      }
      case 'INDEX': {
        const indexes = this.storage.getIndexes(schema);
        const idx = indexes.find(i => i.name === objectName);
        if (!idx) return null;
        return `CREATE ${idx.unique ? 'UNIQUE ' : ''}INDEX ${schema}.${objectName} ON ${schema}.${idx.tableName} (${idx.columns.join(', ')})`;
      }
      case 'VIEW': {
        const viewMeta = this.storage.getViewMeta(schema, objectName);
        if (!viewMeta) return null;
        return `CREATE OR REPLACE VIEW ${schema}.${objectName} AS ${viewMeta.queryText}`;
      }
      case 'SEQUENCE': {
        const seq = this.storage.getSequence(schema, objectName);
        if (!seq) return null;
        return `CREATE SEQUENCE ${schema}.${objectName} START WITH ${seq.currentValue} INCREMENT BY ${seq.incrementBy} MINVALUE ${seq.minValue} MAXVALUE ${seq.maxValue}${seq.cache > 0 ? ` CACHE ${seq.cache}` : ' NOCACHE'}${seq.cycle ? ' CYCLE' : ' NOCYCLE'}`;
      }
      default: return null;
    }
  }


  private evaluateCase(expr: CaseExpr, row: StorageRow, columns: StorageColMeta[]): CellValue {
    if (expr.operand) {
      const val = this.evaluateExpression(expr.operand, row, columns);
      for (const wc of expr.whenClauses) {
        const whenVal = this.evaluateExpression(wc.when, row, columns);
        if (this.compareValues(val, whenVal) === 0) return this.evaluateExpression(wc.then, row, columns);
      }
    } else {
      for (const wc of expr.whenClauses) {
        if (this.evaluateCondition(wc.when, row, columns)) return this.evaluateExpression(wc.then, row, columns);
      }
    }
    return expr.elseClause ? this.evaluateExpression(expr.elseClause, row, columns) : null;
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private resolveColumnIndex(expr: Expression, columns: StorageColMeta[]): number {
    if (expr.type === 'Identifier') {
      const name = expr.name.toUpperCase();
      const table = expr.table?.toUpperCase();
      const qualified = table ? `${table}.${name}` : null;

      // Try qualified match first (e.g., E.DEPT_ID)
      if (qualified) {
        const idx = columns.findIndex(c => {
          const qNames = (c as StorageColMeta & { _qualifiedNames?: string[] })._qualifiedNames;
          if (qNames) return qNames.some(qn => qn.toUpperCase() === qualified);
          return false;
        });
        // If a table qualifier was given, only return qualified match (don't fall through to plain name)
        return idx;
      }

      // Try plain name match (no table qualifier) — check for ambiguity
      const matchingIndices: number[] = [];
      for (let i = 0; i < columns.length; i++) {
        if (columns[i].name === name) matchingIndices.push(i);
      }
      if (matchingIndices.length > 1) {
        throw new OracleError(918, `column ambiguously defined`);
      }
      if (matchingIndices.length === 1) return matchingIndices[0];

      // Try qualified names for unqualified reference — also check ambiguity
      const qMatchIndices: number[] = [];
      for (let i = 0; i < columns.length; i++) {
        const qNames = (columns[i] as StorageColMeta & { _qualifiedNames?: string[] })._qualifiedNames;
        if (qNames && qNames.some(qn => qn.toUpperCase() === name)) qMatchIndices.push(i);
      }
      if (qMatchIndices.length > 1) {
        throw new OracleError(918, `column ambiguously defined`);
      }
      return qMatchIndices.length === 1 ? qMatchIndices[0] : -1;
    }
    if (expr.type === 'Literal' && expr.dataType === 'number') {
      return Number(expr.value) - 1; // 1-based in ORDER BY
    }
    return -1;
  }

  private toNumber(value: CellValue): number {
    if (typeof value === 'number') return value;
    const n = Number(value);
    if (isNaN(n)) throw new OracleError(1722, 'invalid number');
    return n;
  }

  /** Convert an interval literal (`'1' HOUR`, `'7' DAY`, …) into days. */
  private intervalToDays(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const m = value.match(/^-?(\d+(?:\.\d+)?)\s+(YEAR|MONTH|DAY|HOUR|MINUTE|SECOND)\b/i);
    if (!m) return null;
    const amount = Number(m[1]);
    const unit = m[2].toUpperCase();
    const sign = value.startsWith('-') ? -1 : 1;
    switch (unit) {
      case 'YEAR':   return sign * amount * 365;
      case 'MONTH':  return sign * amount * 30;
      case 'DAY':    return sign * amount;
      case 'HOUR':   return sign * amount / 24;
      case 'MINUTE': return sign * amount / 1440;
      case 'SECOND': return sign * amount / 86_400;
      default: return null;
    }
  }

  private applyBinaryOp(op: string, left: CellValue, right: CellValue): CellValue {
    if (op === '||') return (left != null ? String(left) : '') + (right != null ? String(right) : '');
    if (left == null || right == null) return null;
    // Date arithmetic: DATE ± NUMBER → DATE, DATE − DATE → NUMBER (days),
    // DATE ± INTERVAL → DATE.
    if (op === '+' || op === '-') {
      const lDate = this.coerceToDateMs(left);
      const rDate = this.coerceToDateMs(right);
      const DAY = 86_400_000;
      // INTERVAL handling — convert to fractional days, fall into number path.
      const lInt = lDate === null ? this.intervalToDays(left) : null;
      const rInt = rDate === null ? this.intervalToDays(right) : null;
      const lNum = lInt ?? (typeof left === 'number' ? left : null);
      const rNum = rInt ?? (typeof right === 'number' ? right : null);

      if (lDate !== null && rDate !== null) {
        if (op === '-') return (lDate - rDate) / DAY;
        // DATE + DATE is not legal in Oracle (ORA-00975) — fall through.
      } else if (lDate !== null && (rNum !== null || typeof right !== 'string')) {
        const days = rNum ?? Number(right);
        if (!Number.isNaN(days)) {
          const out = op === '+' ? lDate + days * DAY : lDate - days * DAY;
          return new Date(out).toISOString().slice(0, 19).replace('T', ' ');
        }
      } else if (rDate !== null && (lNum !== null || typeof left !== 'string') && op === '+') {
        const days = lNum ?? Number(left);
        if (!Number.isNaN(days)) {
          return new Date(rDate + days * DAY).toISOString().slice(0, 19).replace('T', ' ');
        }
      }
    }
    const l = this.toNumber(left);
    const r = this.toNumber(right);
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': if (r === 0) throw new OracleError(1476, 'divisor is equal to zero'); return l / r;
      default: return this.applyComparison(op, left, right) ? 1 : 0;
    }
  }

  /**
   * Detects an Oracle-shaped date scalar — either a JS `Date` or an
   * ISO-ish string `YYYY-MM-DD[ T]HH:MM:SS[.fff[Z]]`. Returns its epoch
   * milliseconds, or `null` if the value is not a date.
   */
  private coerceToDateMs(value: CellValue): number | null {
    if (value instanceof Date) return value.getTime();
    if (typeof value !== 'string') return null;
    // Reject pure numeric strings ("1", "100") that just happen to parse.
    if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) return null;
    const ms = Date.parse(value.replace(' ', 'T'));
    return Number.isNaN(ms) ? null : ms;
  }


  private applyComparison(op: string, left: CellValue, right: CellValue): boolean {
    if (left === null || right === null) return false;
    const cmp = this.compareValues(left, right);
    switch (op) {
      case '=': return cmp === 0;
      case '<>': case '!=': return cmp !== 0;
      case '<': return cmp < 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '>=': return cmp >= 0;
      default: return false;
    }
  }

  /**
   * Comparator for one ORDER BY item. Oracle treats NULL as the largest
   * value: last in ASC, first in DESC — unless an explicit NULLS
   * FIRST/LAST overrides the default. The override applies regardless of
   * direction, so NULL placement is decided here, before the DESC flip.
   */
  private compareWithOrderSpec(
    a: CellValue, b: CellValue,
    spec: Pick<OrderByItem, 'direction' | 'nullsPosition'>,
  ): number {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull || bNull) {
      if (aNull && bNull) return 0;
      const nullsFirst = spec.nullsPosition
        ? spec.nullsPosition === 'FIRST'
        : spec.direction === 'DESC';
      return aNull === nullsFirst ? -1 : 1;
    }
    const cmp = this.compareValues(a, b);
    return spec.direction === 'DESC' ? -cmp : cmp;
  }

  /** Oracle 3-way comparison — shared with the SQL function registry. */
  private compareValues(a: CellValue, b: CellValue): number {
    return compareOracleValues(a, b);
  }

  private expandSelectItems(items: SelectItem[], columns: StorageColMeta[]): { name: string; alias?: string; colIndex: number; dataType: import('../engine/catalog/DataType').ColumnDataType; expr?: Expression }[] {
    const result: { name: string; alias?: string; colIndex: number; dataType: import('../engine/catalog/DataType').ColumnDataType; expr?: Expression }[] = [];
    for (const item of items) {
      if (item.expr.type === 'Star') {
        const starTable = (item.expr as StarExpr).table?.toUpperCase();
        if (starTable && columns.length > 0) {
          // table.* — validate the table alias exists in columns
          const hasTable = columns.some(c => {
            const qNames = (c as StorageColMeta & { _qualifiedNames?: string[] })._qualifiedNames;
            return qNames?.some(qn => qn.toUpperCase().startsWith(starTable + '.'));
          });
          if (!hasTable) {
            throw new OracleError(904, `"${starTable}".*: invalid identifier`);
          }
          // Only include columns from this table
          for (const col of columns) {
            const qNames = (col as StorageColMeta & { _qualifiedNames?: string[] })._qualifiedNames;
            if (qNames?.some(qn => qn.toUpperCase().startsWith(starTable + '.'))) {
              result.push({ name: col.name, colIndex: col.ordinalPosition, dataType: col.dataType });
            }
          }
        } else {
          for (const col of columns) {
            result.push({ name: col.name, colIndex: col.ordinalPosition, dataType: col.dataType });
          }
        }
      } else if (item.expr.type === 'Identifier') {
        const colIdx = this.resolveColumnIndex(item.expr, columns);
        if (colIdx >= 0) {
          result.push({ name: columns[colIdx].name, alias: item.alias, colIndex: colIdx, dataType: columns[colIdx].dataType });
        } else {
          const name = item.expr.name.toUpperCase();
          const table = (item.expr as IdentifierExpr).table?.toUpperCase();
          // Check if it's a known pseudo-column or package reference
          const knownPseudo = !table && ['SYSDATE', 'CURRENT_DATE', 'SYSTIMESTAMP', 'CURRENT_TIMESTAMP', 'USER', 'ROWNUM'].includes(name);
          const knownPackage = !!table && ['DBMS_RANDOM', 'DBMS_UTILITY', 'DBMS_LOB'].includes(table);
          if (!knownPseudo && !knownPackage && columns.length > 0) {
            const displayName = table ? `${table}.${name}` : name;
            throw new OracleError(904, `"${displayName}": invalid identifier`);
          }
          result.push({ name: item.alias || name, colIndex: -1, dataType: parseOracleType('VARCHAR2'), expr: item.expr });
        }
      } else {
        const alias = item.alias || this.exprToString(item.expr);
        result.push({ name: alias, alias: item.alias, colIndex: -1, dataType: parseOracleType('VARCHAR2'), expr: item.expr });
      }
    }
    return result;
  }

  private exprToString(expr: Expression): string {
    switch (expr.type) {
      case 'Literal': return String(expr.value ?? 'NULL');
      case 'Identifier': return expr.name;
      case 'FunctionCall': return `${expr.name}(...)`;
      case 'BinaryExpr': return `${this.exprToString(expr.left)} ${expr.operator} ${this.exprToString(expr.right)}`;
      default: return 'EXPR';
    }
  }

}



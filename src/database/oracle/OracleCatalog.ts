/**
 * OracleCatalog — Oracle data dictionary implementation.
 *
 * Provides V$ dynamic performance views and DBA_/ALL_/USER_ dictionary views.
 * Queries against these views return simulated metadata from the storage layer.
 */

import { BaseCatalog, type CatalogUser } from '../engine/catalog/BaseCatalog';
import { type ResultSet, queryResult, emptyResult } from '../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../engine/catalog/DataType';
import type { OracleStorage } from './OracleStorage';
import type { OracleInstance } from './OracleInstance';
import { ORACLE_CONFIG } from '../../terminal/commands/OracleConfig';
import { queryView, listCatalogViewEntries, type CatalogViewEntry } from './views/registry';
import { BUILTIN_VIEWS } from './views/builtinCatalog';
import type { SecurityEngine } from './security/SecurityEngine';
// Side-effect import: each file under `views/` self-registers its
// definition. Adding a new view requires only creating a new file there
// and adding it to `views/index.ts` — no edits to the catalog.
import './views';

/** Stored PL/SQL unit shape (avoids circular import with OracleDatabase) */
interface StoredUnit {
  schema: string; name: string; type: string;
  parameters: Array<{ name: string; mode: string; dataType: string }>;
  returnType?: string; body: string; sourceLines: string[];
  created: Date; status: string;
}

/** Audit trail entry shape */
export interface AuditEntry {
  sessionId: number;
  osUsername: string;
  username: string;
  userhost: string;
  terminal: string;
  timestamp: Date;
  actionName: string;
  objName: string | null;
  objOwner: string | null;
  returncode: number;
  privUsed: string | null;
  sqlText: string | null;
  statementType: string | null;
}

/** Statement-level audit option shape */
export interface StmtAuditOption {
  auditOption: string;
  userName: string | null; // null = all users
  success: string; // BY ACCESS or BY SESSION
  failure: string; // BY ACCESS or BY SESSION
}

/** Fine-grained audit policy */
export interface FgaPolicy {
  objectSchema: string;
  objectName: string;
  policyOwner: string;
  policyName: string;
  policyText: string;
  enabled: boolean;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
}

/** Fine-grained audit trail record */
export interface FgaAuditRecord {
  sessionId: number;
  timestamp: Date;
  dbUser: string;
  osUser: string;
  objectSchema: string;
  objectName: string;
  policyName: string;
  sqlText: string;
  statementType: string;
}

/** Parameter descriptions for V$PARAMETER.DESCRIPTION column */
const PARAMETER_DESCRIPTIONS: Record<string, string> = {
  db_name: 'Database name specified in CREATE DATABASE',
  db_domain: 'Directory path prefix for global database name',
  db_unique_name: 'Unique database name',
  db_block_size: 'Size of database block in bytes',
  db_cache_size: 'Size of DEFAULT buffer pool for standard blocks',
  shared_pool_size: 'Size of shared pool in bytes',
  sga_target: 'Target size of SGA',
  sga_max_size: 'Maximum size of SGA for the instance',
  pga_aggregate_target: 'Target size for aggregate PGA memory',
  memory_target: 'Target memory size (SGA+PGA)',
  memory_max_target: 'Maximum memory size for auto memory management',
  processes: 'Max number of user processes',
  sessions: 'Max number of sessions',
  open_cursors: 'Max number of open cursors per session',
  undo_management: 'Instance runs in SMU or Auto Undo mode',
  undo_tablespace: 'Undo tablespace name for auto undo management',
  undo_retention: 'Undo retention in seconds',
  compatible: 'Database will be completely compatible with this release',
  audit_trail: 'Enable system auditing',
  audit_file_dest: 'Directory for audit trail files',
  diagnostic_dest: 'Diagnostic base directory',
  control_files: 'Control file name list',
  log_archive_dest_1: 'Primary archive log destination',
  log_archive_format: 'Archive log file name format',
  db_recovery_file_dest: 'Default database recovery file destination',
  db_recovery_file_dest_size: 'Database recovery file dest size',
  remote_login_passwordfile: 'Password file usage parameter',
  instance_name: 'Instance name for Oracle instance',
  service_names: 'Service names this instance supports',
  nls_language: 'NLS language name',
  nls_territory: 'NLS territory name',
  nls_date_format: 'NLS default date format',
  nls_characterset: 'Database character set',
  optimizer_mode: 'Optimizer mode',
  cursor_sharing: 'Cursor sharing mode',
  recyclebin: 'Enable or disable the recyclebin',
  local_listener: 'Local listener address',
  dispatchers: 'Specifications of dispatchers',
  parallel_max_servers: 'Max number of parallel execution servers',
  parallel_min_servers: 'Min number of parallel execution servers',
  archive_log_mode: 'Archive log mode',
  java_pool_size: 'Size of Java pool in bytes',
  large_pool_size: 'Size of large pool in bytes',
  db_files: 'Max allowable number of database files',
  resource_limit: 'Master switch for resource limit enforcement',
  sec_case_sensitive_logon: 'Case sensitive logon enabled',
};

// ── *_VIEWS columns ──────────────────────────────────────────────────
//
// Shared by DBA_VIEWS, ALL_VIEWS, and USER_VIEWS. The order and types
// match Oracle 19c so audit scripts that SELECT explicit columns work
// without modification.
const VIEW_COLUMNS = [
  { name: 'OWNER', dataType: oracleVarchar2(128) },
  { name: 'VIEW_NAME', dataType: oracleVarchar2(128) },
  { name: 'TEXT_LENGTH', dataType: oracleNumber(10) },
  { name: 'TEXT', dataType: oracleVarchar2(4000) },
  { name: 'TYPE_TEXT_LENGTH', dataType: oracleNumber(10) },
  { name: 'TYPE_TEXT', dataType: oracleVarchar2(4000) },
  { name: 'OID_TEXT_LENGTH', dataType: oracleNumber(10) },
  { name: 'OID_TEXT', dataType: oracleVarchar2(4000) },
  { name: 'VIEW_TYPE_OWNER', dataType: oracleVarchar2(128) },
  { name: 'VIEW_TYPE', dataType: oracleVarchar2(128) },
  { name: 'SUPERVIEW_NAME', dataType: oracleVarchar2(128) },
  { name: 'EDITIONING_VIEW', dataType: oracleVarchar2(1) },
  { name: 'READ_ONLY', dataType: oracleVarchar2(1) },
  { name: 'BEQUEATH', dataType: oracleVarchar2(12) },
  { name: 'ORIGIN_CON_ID', dataType: oracleVarchar2(256) },
  { name: 'DEFAULT_COLLATION', dataType: oracleVarchar2(100) },
  { name: 'CONTAINER_DATA', dataType: oracleVarchar2(1) },
];

function viewRow(owner: string, name: string, text: string): (string | number | null)[] {
  return [
    owner, name, text.length, text,
    0, null,                  // TYPE_TEXT — for object-views (none here)
    0, null,                  // OID_TEXT
    null, null,               // VIEW_TYPE_OWNER, VIEW_TYPE
    null,                     // SUPERVIEW_NAME
    'N', 'N',                 // EDITIONING_VIEW, READ_ONLY
    'CURRENT_USER',           // BEQUEATH
    '1',                      // ORIGIN_CON_ID — single-tenant simulator
    'USING_NLS_COMP',         // DEFAULT_COLLATION
    'N',                      // CONTAINER_DATA
  ];
}

export class OracleCatalog extends BaseCatalog {
  private storage: OracleStorage;
  private instance: OracleInstance;
  /** Schema → password (for authentication) */
  private passwords: Map<string, string> = new Map();
  /** Auto-incrementing user ID counter */
  private nextUserId = 0;
  /** Auto-incrementing session ID */
  private sessionId = 1;

  // ── Audit trail infrastructure ───────────────────────────────────

  /** Audit trail entries (DBA_AUDIT_TRAIL / SYS.AUD$) */
  private auditTrail: AuditEntry[] = [];

  /** Statement-level audit options (DBA_STMT_AUDIT_OPTS) */
  private stmtAuditOpts: StmtAuditOption[] = [];

  /** Fine-grained audit policies (DBA_AUDIT_POLICIES) */
  private fgaPolicies: FgaPolicy[] = [];

  /** Fine-grained audit records (DBA_FGA_AUDIT_TRAIL) */
  private fgaTrail: FgaAuditRecord[] = [];

  /** Maximum size of the audit trail before FIFO eviction. */
  private static readonly MAX_AUDIT_ENTRIES = 5000;

  /** Object-level audit options keyed by `${schema}.${object}` */
  private objAuditOpts: Map<string, Set<string>> = new Map();

  /** Custom profiles (name → resource overrides) */
  private profiles: Map<string, Map<string, string>> = new Map();

  /** Injected provider for stored PL/SQL units (avoids circular dependency) */
  private storedUnitsProvider: (() => StoredUnit[]) | null = null;
  /** Injected SecurityEngine (set after construction to avoid circular dep) */
  private securityEngine: SecurityEngine | null = null;

  /** Set the provider for stored PL/SQL units */
  setStoredUnitsProvider(provider: () => StoredUnit[]): void {
    this.storedUnitsProvider = provider;
  }

  /** Wire in the SecurityEngine after construction. */
  setSecurityEngine(engine: SecurityEngine): void {
    this.securityEngine = engine;
  }

  getSecurityEngine(): SecurityEngine | null {
    return this.securityEngine;
  }

  constructor(storage: OracleStorage, instance: OracleInstance) {
    super();
    this.storage = storage;
    this.instance = instance;
    this.initDefaultUsersAndRoles();
  }

  private initDefaultUsersAndRoles(): void {
    const now = new Date();
    const defaultUsers: (CatalogUser & { password: string })[] = [
      { username: 'SYS', userId: this.nextUserId++, defaultTablespace: 'SYSTEM', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', lockDate: null, expiryDate: null, created: now, profile: 'DEFAULT', authenticationType: 'PASSWORD', password: 'oracle' },
      { username: 'SYSTEM', userId: this.nextUserId++, defaultTablespace: 'SYSTEM', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', lockDate: null, expiryDate: null, created: now, profile: 'DEFAULT', authenticationType: 'PASSWORD', password: 'oracle' },
      { username: 'DBSNMP', userId: this.nextUserId++, defaultTablespace: 'SYSAUX', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', lockDate: null, expiryDate: null, created: now, profile: 'DEFAULT', authenticationType: 'PASSWORD', password: 'dbsnmp' },
      { username: 'HR', userId: this.nextUserId++, defaultTablespace: 'USERS', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', lockDate: null, expiryDate: null, created: now, profile: 'DEFAULT', authenticationType: 'PASSWORD', password: 'hr' },
      { username: 'SCOTT', userId: this.nextUserId++, defaultTablespace: 'USERS', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', lockDate: null, expiryDate: null, created: now, profile: 'DEFAULT', authenticationType: 'PASSWORD', password: 'tiger' },
      { username: 'FCUBSLIVE', userId: this.nextUserId++, defaultTablespace: 'USERS', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', lockDate: null, expiryDate: null, created: now, profile: 'DEFAULT', authenticationType: 'PASSWORD', password: 'fcubs' },
    ];
    for (const u of defaultUsers) {
      const { password, ...user } = u;
      this.createUser(user);
      this.passwords.set(u.username, password);
    }

    // Roles
    for (const r of ['CONNECT', 'RESOURCE', 'DBA', 'SELECT_CATALOG_ROLE', 'EXECUTE_CATALOG_ROLE', 'EXP_FULL_DATABASE', 'IMP_FULL_DATABASE']) {
      this.createRole(r);
    }

    // SYS/SYSTEM privileges
    const allPrivs = ['CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE',
      'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE INDEX', 'CREATE USER', 'ALTER USER',
      'DROP USER', 'CREATE ROLE', 'GRANT ANY PRIVILEGE', 'GRANT ANY ROLE',
      'SELECT ANY TABLE', 'INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE',
      'CREATE ANY TABLE', 'DROP ANY TABLE', 'ALTER ANY TABLE',
      'CREATE TABLESPACE', 'ALTER TABLESPACE', 'DROP TABLESPACE', 'ALTER SYSTEM',
      'ALTER DATABASE', 'UNLIMITED TABLESPACE', 'CREATE ANY DIRECTORY'];
    for (const priv of allPrivs) {
      this.grantSystemPrivilege('SYS', priv, true);
      this.grantSystemPrivilege('SYSTEM', priv, true);
    }

    // DBA role has all privileges
    for (const priv of allPrivs) this.grantSystemPrivilege('DBA', priv, true);
    this.grantRole('SYS', 'DBA', true);
    this.grantRole('SYSTEM', 'DBA', true);

    // CONNECT role (Oracle 10.2+): grants CREATE SESSION only.
    this.grantSystemPrivilege('CONNECT', 'CREATE SESSION');
    // RESOURCE role: object-creation privileges.
    for (const p of ['CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE',
                     'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE TYPE',
                     'CREATE CLUSTER', 'CREATE INDEXTYPE', 'CREATE OPERATOR']) {
      this.grantSystemPrivilege('RESOURCE', p);
    }

    // HR, SCOTT, and FCUBSLIVE get basic privileges
    for (const u of ['HR', 'SCOTT', 'FCUBSLIVE']) {
      this.grantRole(u, 'CONNECT');
      this.grantRole(u, 'RESOURCE');
      this.grantSystemPrivilege(u, 'CREATE SESSION');
      this.grantSystemPrivilege(u, 'CREATE TABLE');
      this.grantSystemPrivilege(u, 'CREATE VIEW');
      this.grantSystemPrivilege(u, 'CREATE SEQUENCE');
      this.grantSystemPrivilege(u, 'UNLIMITED TABLESPACE');
    }
  }

  // ── Authentication ───────────────────────────────────────────────

  authenticate(username: string, password: string): boolean {
    const upper = username.toUpperCase();
    if (!this.userExists(upper)) return false;
    const stored = this.passwords.get(upper);
    if (stored === undefined) return false;
    return stored === password;
  }

  getStoredPassword(username: string): string | undefined {
    return this.passwords.get(username.toUpperCase());
  }

  setPassword(username: string, password: string): void {
    this.passwords.set(username.toUpperCase(), password);
  }

  /** Distinguished name registered for IDENTIFIED GLOBALLY users. */
  private externalNames: Map<string, string> = new Map();

  setExternalName(username: string, dn: string): void {
    this.externalNames.set(username.toUpperCase(), dn);
  }

  getExternalName(username: string): string | undefined {
    return this.externalNames.get(username.toUpperCase());
  }

  /** Allocate a unique user ID for new users */
  allocateUserId(): number {
    return this.nextUserId++;
  }

  // ── Audit trail recording ──────────────────────────────────────

  /** Record an audit trail entry */
  recordAudit(entry: Partial<AuditEntry> & Pick<AuditEntry, 'username' | 'actionName' | 'returncode'>): void {
    this.auditTrail.push({
      sessionId: entry.sessionId ?? this.sessionId,
      osUsername: entry.osUsername ?? 'oracle',
      userhost: entry.userhost ?? 'localhost',
      terminal: entry.terminal ?? 'pts/0',
      timestamp: entry.timestamp ?? new Date(),
      username: entry.username,
      actionName: entry.actionName,
      objName: entry.objName ?? null,
      objOwner: entry.objOwner ?? null,
      returncode: entry.returncode,
      privUsed: entry.privUsed ?? null,
      sqlText: entry.sqlText ?? null,
      statementType: entry.statementType ?? entry.actionName,
    });
    if (this.auditTrail.length > OracleCatalog.MAX_AUDIT_ENTRIES) {
      this.auditTrail.splice(0, this.auditTrail.length - OracleCatalog.MAX_AUDIT_ENTRIES);
    }
  }

  /** Record a successful or failed LOGON */
  recordLogon(username: string, sessionId: number, returncode: number, osUsername = 'oracle', userhost = 'localhost', terminal = 'pts/0'): void {
    this.recordAudit({
      sessionId, username: username.toUpperCase(), actionName: 'LOGON',
      returncode, osUsername, userhost, terminal,
      statementType: 'LOGON',
    });
  }

  /** Record a LOGOFF */
  recordLogoff(username: string, sessionId: number, osUsername = 'oracle', userhost = 'localhost', terminal = 'pts/0'): void {
    this.recordAudit({
      sessionId, username: username.toUpperCase(), actionName: 'LOGOFF',
      returncode: 0, osUsername, userhost, terminal,
      statementType: 'LOGOFF',
    });
  }

  /** Read-only snapshot of the audit trail (most recent last). */
  getAuditTrail(): readonly AuditEntry[] { return this.auditTrail; }

  /** Read-only snapshot of statement audit options. */
  getStmtAuditOpts(): readonly StmtAuditOption[] { return this.stmtAuditOpts; }

  /** Add a statement-level audit option */
  addStmtAuditOption(option: StmtAuditOption): void {
    // Remove any existing matching option first
    this.stmtAuditOpts = this.stmtAuditOpts.filter(o =>
      !(o.auditOption === option.auditOption && o.userName === option.userName)
    );
    this.stmtAuditOpts.push(option);
  }

  /** Remove a statement-level audit option */
  removeStmtAuditOption(auditOption: string, userName: string | null): void {
    this.stmtAuditOpts = this.stmtAuditOpts.filter(o =>
      !(o.auditOption === auditOption && o.userName === userName)
    );
  }

  /** Add an object-level audit option (AUDIT priv ON schema.obj). */
  addObjectAuditOption(schema: string, object: string, action: string): void {
    const key = `${schema.toUpperCase()}.${object.toUpperCase()}`;
    const set = this.objAuditOpts.get(key) ?? new Set<string>();
    set.add(action.toUpperCase());
    this.objAuditOpts.set(key, set);
  }

  /** Get the object audit options map (read-only view). */
  getObjectAuditOpts(): ReadonlyMap<string, ReadonlySet<string>> {
    return this.objAuditOpts;
  }

  // ── Fine-grained auditing ────────────────────────────────────────

  /** Register a new FGA policy. */
  addFgaPolicy(policy: FgaPolicy): void {
    this.fgaPolicies = this.fgaPolicies.filter(p =>
      !(p.objectSchema === policy.objectSchema && p.objectName === policy.objectName && p.policyName === policy.policyName)
    );
    this.fgaPolicies.push(policy);
  }

  /** Drop an FGA policy by name (and object). */
  dropFgaPolicy(objectSchema: string, objectName: string, policyName: string): void {
    this.fgaPolicies = this.fgaPolicies.filter(p =>
      !(p.objectSchema.toUpperCase() === objectSchema.toUpperCase()
        && p.objectName.toUpperCase() === objectName.toUpperCase()
        && p.policyName.toUpperCase() === policyName.toUpperCase())
    );
  }

  getFgaPolicies(): readonly FgaPolicy[] { return this.fgaPolicies; }

  /** Record an FGA audit hit (matching policy executed). */
  recordFgaAudit(rec: FgaAuditRecord): void {
    this.fgaTrail.push(rec);
    if (this.fgaTrail.length > OracleCatalog.MAX_AUDIT_ENTRIES) {
      this.fgaTrail.splice(0, this.fgaTrail.length - OracleCatalog.MAX_AUDIT_ENTRIES);
    }
  }

  getFgaTrail(): readonly FgaAuditRecord[] { return this.fgaTrail; }

  /**
   * Resolve a dictionary view to its column metadata — used by DESC
   * so `DESC ALL_VIEWS` succeeds even with no user views in storage.
   *
   * Returns null when the name is not a known catalog view. The schema
   * is taken from the empty `ResultSet` produced by `queryCatalogView`
   * — we never actually scan rows for DESC.
   */
  describeCatalogView(name: string, currentUser: string): { name: string; nullable: boolean; type: string; precision?: number; scale?: number }[] | null {
    const upper = name.toUpperCase();
    // First, treat the well-known dictionary views uniformly via the
    // existing query path. Many of these return an empty result when
    // there is no data — that's fine; we only need the columns.
    const rs = this.queryCatalogView(upper, currentUser);
    if (!rs || !rs.isQuery) return null;
    return rs.columns.map(c => ({
      name: c.name,
      nullable: c.dataType.nullable !== false,
      type: c.dataType.name,
      precision: c.dataType.precision,
      scale: c.dataType.scale,
    }));
  }

  /** Is `name` a known built-in dictionary view? */
  isBuiltinCatalogView(name: string): boolean {
    return this.mergedCatalogViews().has(name.toUpperCase());
  }

  /**
   * Match a DML statement against any FGA policy. Returns matching
   * policies (empty if none). Called by the executor before/after a
   * statement to trigger fine-grained audit recording.
   */
  matchFgaPolicies(schema: string, object: string, action: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'): FgaPolicy[] {
    const sUpper = schema.toUpperCase();
    const oUpper = object.toUpperCase();
    return this.fgaPolicies.filter(p =>
      p.enabled && p.objectSchema.toUpperCase() === sUpper
        && p.objectName.toUpperCase() === oUpper
        && ((action === 'SELECT' && p.select) ||
            (action === 'INSERT' && p.insert) ||
            (action === 'UPDATE' && p.update) ||
            (action === 'DELETE' && p.delete))
    );
  }

  // ── Profile management ──────────────────────────────────────────

  /** Create a custom profile with resource limit overrides */
  createProfile(name: string, limits: Map<string, string>): void {
    const upper = name.toUpperCase();
    this.profiles.set(upper, limits);
    this.securityEngine?.profiles.createProfile(upper, limits);
  }

  /** Alter an existing profile's limits */
  alterProfile(name: string, limits: Map<string, string>): void {
    const upper = name.toUpperCase();
    const existing = this.profiles.get(upper);
    if (!existing && upper !== 'DEFAULT') throw new Error(`Profile ${upper} does not exist`);
    if (existing) {
      for (const [k, v] of limits) existing.set(k, v);
    } else {
      // Altering DEFAULT profile
      const defMap = this.profiles.get('DEFAULT') ?? new Map<string, string>();
      for (const [k, v] of limits) defMap.set(k, v);
      this.profiles.set('DEFAULT', defMap);
    }
    this.securityEngine?.profiles.alterProfile(upper, limits);
  }

  /** Drop a custom profile */
  dropProfile(name: string): void {
    const upper = name.toUpperCase();
    this.profiles.delete(upper);
    if (this.securityEngine?.profiles.profileExists(upper)) {
      this.securityEngine.profiles.dropProfile(upper);
    }
  }

  /** Check if a profile exists */
  profileExists(name: string): boolean {
    const upper = name.toUpperCase();
    if (upper === 'DEFAULT') return true;
    if (this.profiles.has(upper)) return true;
    return this.securityEngine?.profiles.profileExists(upper) ?? false;
  }

  override dropUser(username: string): void {
    const upper = username.toUpperCase();
    this.passwords.delete(upper);
    super.dropUser(upper);
  }

  // ── Catalog view queries ─────────────────────────────────────────

  queryCatalogView(viewName: string, currentUser: string): ResultSet | null {
    const upper = viewName.toUpperCase();

    // V$ views
    if (upper.startsWith('V$') || upper.startsWith('V_$')) {
      return this.queryVDollar(upper.replace('V_$', 'V$'), currentUser);
    }

    // GV$ views — in a real RAC cluster, GV$X = UNION ALL of every
    // instance's V$X with an extra INST_ID column. We simulate a
    // single-instance database, so we delegate to the V$ equivalent and
    // prepend INST_ID = 1.
    if (upper.startsWith('GV$') || upper.startsWith('GV_$')) {
      const vName = upper.replace(/^GV_?\$/, 'V$');
      const base = this.queryVDollar(vName, currentUser);
      if (!base || !base.isQuery) return base;
      return queryResult(
        [{ name: 'INST_ID', dataType: oracleNumber(10) }, ...base.columns],
        base.rows.map(r => [1, ...r])
      );
    }

    // DBA_ views
    if (upper.startsWith('DBA_')) return this.queryDBA(upper, currentUser);
    // ALL_ views
    if (upper.startsWith('ALL_')) return this.queryALL(upper, currentUser);
    // USER_ views
    if (upper.startsWith('USER_')) return this.queryUSER(upper, currentUser);

    // Special tables
    if (upper === 'DICTIONARY' || upper === 'DICT') return this.queryDictionary();
    if (upper === 'DUAL') return this.queryDual();
    if (upper === 'TAB' || upper === 'CAT') return this.queryTabCat(currentUser);

    // SYS internal tables (SYS.OBJ$, SYS.TAB$, etc.)
    if (upper.startsWith('SYS.')) return this.querySysInternal(upper.substring(4));

    // Generic catalog views registered by `views/*.ts` (PRODUCT_COMPONENT_VERSION,
    // NLS_DATABASE_PARAMETERS, UNIFIED_AUDIT_TRAIL, …).
    const fromRegistry = queryView(upper, {
      instance: this.instance,
      storage: this.storage,
      runtime: this.instance.getRuntimeState(),
      catalog: this,
      currentUser,
    });
    if (fromRegistry) return fromRegistry;

    return null;
  }

  private queryDual(): ResultSet {
    return queryResult(
      [{ name: 'DUMMY', dataType: oracleVarchar2(1) }],
      [['X']]
    );
  }

  // ── V$ Dynamic Performance Views ─────────────────────────────────

  private queryVDollar(name: string, _currentUser: string): ResultSet | null {
    switch (name) {
      case 'V$VERSION': return this.vVersion();
      case 'V$INSTANCE': return this.vInstance();
      case 'V$DATABASE': return this.vDatabase();
      case 'V$SESSION': return this.vSession(_currentUser);
      case 'V$PARAMETER':
      case 'V$SYSTEM_PARAMETER': return this.vParameter();
      case 'V$SPPARAMETER': return this.vSpParameter();
      case 'V$SGA': return this.vSga();
      case 'V$TABLESPACE': return this.vTablespace();
      case 'V$DATAFILE': return this.vDatafile();
      case 'V$LOG': return this.vLog();
      case 'V$LOGFILE': return this.vLogfile();
      case 'V$PROCESS': return this.vProcess();
      case 'V$CONTROLFILE': return this.vControlfile();
      case 'V$DIAG_INFO': return this.vDiagInfo();
      case 'V$SGASTAT': return this.vSgastat();
      case 'V$LOCK': return this.vLock();
      case 'V$LOCKED_OBJECT': return this.vLockedObject();
      case 'V$TRANSACTION': return this.vTransaction();
      case 'V$SQL': return this.vSql();
      case 'V$SQLAREA': return this.vSqlarea();
      case 'V$SYSSTAT': return this.vSysstat();
      case 'V$SESSTAT': return this.vSesstat(_currentUser);
      case 'V$OPEN_CURSOR': return this.vOpenCursor(_currentUser);
      case 'V$TEMPFILE': return this.vTempfile();
      case 'V$ARCHIVED_LOG': return this.vArchivedLog();
      case 'V$RECOVER_FILE': return this.vRecoverFile();
      case 'V$BACKUP': return this.vBackup();
      case 'V$OPTION': return this.vOption();
      case 'V$NLS_PARAMETERS': return this.vNlsParameters();
      case 'V$TIMEZONE_NAMES': return this.vTimezoneNames();
      case 'V$PGA_TARGET_ADVICE': return this.vPgaTargetAdvice();
      case 'V$SQL_PLAN': return this.vSqlPlan();
      case 'V$RESOURCE_LIMIT': return this.vResourceLimit();
      case 'V$ASM_DISKGROUP': return this.vAsmDiskgroup();
      case 'V$SESSION_CONNECT_INFO': return this.vSessionConnectInfo();
      default: {
        const fromRegistry = queryView(name, {
          instance: this.instance,
          storage: this.storage,
          runtime: this.instance.getRuntimeState(),
          currentUser: _currentUser,
        });
        if (fromRegistry) return fromRegistry;
        return emptyResult(`View ${name} not implemented`);
      }
    }
  }

  private vVersion(): ResultSet {
    const banners = this.instance.getVersionBanner();
    return queryResult(
      [{ name: 'BANNER', dataType: oracleVarchar2(200) }],
      banners.map(b => [b])
    );
  }

  private vInstance(): ResultSet {
    return queryResult(
      [
        { name: 'INSTANCE_NUMBER', dataType: oracleNumber(10) },
        { name: 'INSTANCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'HOST_NAME', dataType: oracleVarchar2(64) },
        { name: 'VERSION', dataType: oracleVarchar2(30) },
        { name: 'STARTUP_TIME', dataType: oracleDate() },
        { name: 'STATUS', dataType: oracleVarchar2(12) },
        { name: 'DATABASE_STATUS', dataType: oracleVarchar2(12) },
        { name: 'INSTANCE_ROLE', dataType: oracleVarchar2(30) },
      ],
      [[
        1, this.instance.config.sid, 'localhost', '19.0.0.0.0',
        this.instance.startupTime?.toISOString() ?? null,
        this.instance.state === 'OPEN' ? 'OPEN' : this.instance.state,
        this.instance.state === 'OPEN' ? 'ACTIVE' : 'SUSPENDED',
        'PRIMARY_INSTANCE',
      ]]
    );
  }

  private vDatabase(): ResultSet {
    return queryResult(
      [
        { name: 'DBID', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(9) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'LOG_MODE', dataType: oracleVarchar2(12) },
        { name: 'OPEN_MODE', dataType: oracleVarchar2(20) },
        { name: 'DATABASE_ROLE', dataType: oracleVarchar2(16) },
        { name: 'PLATFORM_NAME', dataType: oracleVarchar2(101) },
      ],
      [[
        1234567890, this.instance.config.sid, new Date().toISOString(),
        this.instance.archiveLogMode ? 'ARCHIVELOG' : 'NOARCHIVELOG',
        this.instance.state === 'OPEN' ? 'READ WRITE' : 'MOUNTED',
        'PRIMARY', 'Linux x86 64-bit',
      ]]
    );
  }

  private vSession(currentUser: string): ResultSet {
    const cols = [
      { name: 'SID', dataType: oracleNumber(10) },
      { name: 'SERIAL#', dataType: oracleNumber(10) },
      { name: 'USERNAME', dataType: oracleVarchar2(128) },
      { name: 'STATUS', dataType: oracleVarchar2(8) },
      { name: 'OSUSER', dataType: oracleVarchar2(128) },
      { name: 'MACHINE', dataType: oracleVarchar2(64) },
      { name: 'PROGRAM', dataType: oracleVarchar2(64) },
      { name: 'TYPE', dataType: oracleVarchar2(10) },
      { name: 'LOGON_TIME', dataType: oracleDate() },
      { name: 'SCHEMANAME', dataType: oracleVarchar2(128) },
      { name: 'COMMAND', dataType: oracleNumber(10) },
      { name: 'SQL_ID', dataType: oracleVarchar2(13) },
      { name: 'TERMINAL', dataType: oracleVarchar2(30) },
      { name: 'BLOCKING_SESSION', dataType: oracleNumber(10) },
      { name: 'SQL_CHILD_NUMBER', dataType: oracleNumber(10) },
      { name: 'SQL_EXEC_START', dataType: oracleDate() },
      { name: 'SQL_EXEC_ID', dataType: oracleNumber(20) },
      { name: 'EVENT', dataType: oracleVarchar2(64) },
      { name: 'WAIT_CLASS', dataType: oracleVarchar2(64) },
      { name: 'SECONDS_IN_WAIT', dataType: oracleNumber(10) },
      { name: 'STATE', dataType: oracleVarchar2(32) },
      { name: 'LAST_CALL_ET', dataType: oracleNumber(10) },
      { name: 'SQL_TRACE', dataType: oracleVarchar2(8) },
      { name: 'RESOURCE_CONSUMER_GROUP', dataType: oracleVarchar2(32) },
      { name: 'SERVICE_NAME', dataType: oracleVarchar2(64) },
      { name: 'MODULE', dataType: oracleVarchar2(64) },
      { name: 'ACTION', dataType: oracleVarchar2(64) },
      { name: 'CLIENT_INFO', dataType: oracleVarchar2(64) },
      { name: 'PADDR', dataType: oracleVarchar2(16) },
      { name: 'TADDR', dataType: oracleVarchar2(16) },
      { name: 'LOCKWAIT', dataType: oracleVarchar2(16) },
    ];

    const engine = this.securityEngine;
    const activeSessions = engine?.sessions.getAllSessions() ?? [];
    const now = new Date().toISOString();

    // Always include Oracle background processes (PMON, SMON, DBW0, LGWR).
    const bgRow = (sid: number, prog: string): (string | number | null)[] => [
      sid, 1, 'SYS', 'ACTIVE', 'oracle', 'localhost', prog, 'BACKGROUND',
      now, 'SYS', 0, null,
      'UNKNOWN', null, null, null, null,
      'pmon timer', 'Idle', 0, 'WAITING', 0, 'DISABLED',
      'SYS_GROUP', 'orcl', null, null, null, null, null, null,
    ];
    const bgRows: (string | number | null)[][] = [
      bgRow(1, 'oracle@localhost (PMON)'),
      bgRow(2, 'oracle@localhost (SMON)'),
      bgRow(3, 'oracle@localhost (DBW0)'),
      bgRow(4, 'oracle@localhost (LGWR)'),
    ];

    if (activeSessions.length > 0) {
      // Use real tracked sessions from SecurityEngine, prepend background rows
      const userRows = activeSessions.map(s => [
        s.sid, s.serial, s.username, s.status,
        s.osUser, s.machine, s.program, s.type,
        s.logonTime.toISOString(), s.schema,
        3, // COMMAND (3 = SELECT)
        s.sqlId,
        s.terminal,
        s.blockingSession,
        s.sqlChildNumber,
        s.sqlExecStart ? s.sqlExecStart.toISOString() : null,
        s.sqlExecStart ? 1 : null,
        s.event,
        s.waitClass,
        s.secondsInWait,
        s.state,
        s.lastCallEt,
        'DISABLED',
        s.resourceConsumerGroup,
        s.service,
        s.module,
        s.action,
        s.clientInfo,
        null, null, null,
      ]);
      return queryResult(cols, [...bgRows, ...userRows]);
    }

    // Fallback when no sessions registered: show background + a synthetic user session
    const upper = currentUser.toUpperCase();
    return queryResult(cols, [
      ...bgRows,
      [
        10, 100, upper, 'ACTIVE', 'oracle', 'localhost',
        'sqlplus@localhost', 'USER', now, upper, 3, null,
        'pts/0', null, null, null, null,
        'SQL*Net message from client', 'Idle', 0, 'WAITING', 0, 'DISABLED',
        'DEFAULT_CONSUMER_GROUP', 'orcl', null, null, null, null, null, null,
      ],
    ]);
  }

  private vSessionConnectInfo(): ResultSet {
    const engine = this.securityEngine;
    const sessions = engine?.sessions.getAllSessions() ?? [];
    const runtime = this.instance.getRuntimeState();
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'SERIAL#', dataType: oracleNumber(10) },
        { name: 'AUTHENTICATION_TYPE', dataType: oracleVarchar2(26) },
        { name: 'OSUSER', dataType: oracleVarchar2(30) },
        { name: 'NETWORK_SERVICE_BANNER', dataType: oracleVarchar2(256) },
        { name: 'CLIENT_CHARSET', dataType: oracleVarchar2(30) },
        { name: 'CLIENT_CONNECTION', dataType: oracleVarchar2(12) },
        { name: 'CLIENT_OCI_LIBRARY', dataType: oracleVarchar2(30) },
        { name: 'CLIENT_VERSION', dataType: oracleVarchar2(30) },
      ],
      sessions.map(s => [
        s.sid, s.serial,
        s.username === 'SYS' ? 'OS' : 'DATABASE',
        s.osUser,
        runtime.listenerEndpoint || 'TCP loopback',
        'AL32UTF8', 'Heterogeneous', 'Linux Userspace', '19.3.0.0.0',
      ])
    );
  }

  private vParameter(): ResultSet {
    const params = this.instance.getAllParameters();
    return queryResult(
      [
        { name: 'NUM', dataType: { name: 'NUMBER', nullable: true } },
        { name: 'NAME', dataType: oracleVarchar2(80) },
        { name: 'TYPE', dataType: { name: 'NUMBER', nullable: true } },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
        { name: 'DISPLAY_VALUE', dataType: oracleVarchar2(512) },
        { name: 'ISDEFAULT', dataType: oracleVarchar2(9) },
        { name: 'ISMODIFIED', dataType: oracleVarchar2(10) },
        { name: 'DESCRIPTION', dataType: oracleVarchar2(255) },
      ],
      Array.from(params.entries()).map(([name, value], idx) => {
        const type = this.getParamType(value);
        const isDefault = this.instance.isParameterModified(name) ? 'FALSE' : 'TRUE';
        const isModified = this.instance.isParameterModified(name) ? 'MODIFIED' : 'FALSE';
        const desc = PARAMETER_DESCRIPTIONS[name] ?? '';
        return [idx + 1, name, type, value, value, isDefault, isModified, desc];
      })
    );
  }

  private vSpParameter(): ResultSet {
    const params = this.instance.getSpfileParameters();
    return queryResult(
      [
        { name: 'SID', dataType: oracleVarchar2(80) },
        { name: 'NAME', dataType: oracleVarchar2(80) },
        { name: 'TYPE', dataType: { name: 'NUMBER', nullable: true } },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
        { name: 'DISPLAY_VALUE', dataType: oracleVarchar2(512) },
        { name: 'ISSPECIFIED', dataType: oracleVarchar2(9) },
      ],
      Array.from(params.entries()).map(([name, value]) => {
        const type = this.getParamType(value);
        return ['*', name, type, value, value, 'TRUE'];
      })
    );
  }

  private getParamType(value: string): number {
    // Oracle V$PARAMETER TYPE: 1=Boolean, 2=String, 3=Integer, 6=Big integer
    if (value === 'TRUE' || value === 'FALSE') return 1;
    if (/^\d+$/.test(value)) return 3;
    if (/^\d+[MmGgKk]$/.test(value)) return 6;
    return 2;
  }

  private vSga(): ResultSet {
    const sga = this.instance.getSGAInfo();
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(40) },
        { name: 'VALUE', dataType: oracleVarchar2(20) },
      ],
      [
        ['Total System Global Area', sga.totalSize],
        ['Fixed Size', '2M'],
        ['Variable Size', sga.sharedPool],
        ['Database Buffers', sga.bufferCache],
        ['Redo Buffers', sga.redoLogBuffer],
      ]
    );
  }

  private vTablespace(): ResultSet {
    const tablespaces = this.storage.getAllTablespaces();
    return queryResult(
      [
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'BIGFILE', dataType: oracleVarchar2(3) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
      ],
      tablespaces.map((ts, i) => [i, ts.name, 'NO', ts.blockSize])
    );
  }

  private vDatafile(): ResultSet {
    const tablespaces = this.storage.getAllTablespaces();
    const rows: (string | number | null)[][] = [];
    let fileNum = 1;
    for (const ts of tablespaces) {
      for (const df of ts.datafiles) {
        rows.push([fileNum++, df.path, ts.name, df.size, df.autoextend ? 'YES' : 'NO']);
      }
    }
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'TS#_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleVarchar2(20) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  }

  private vLog(): ResultSet {
    const groups = this.instance.getRedoLogGroups();
    return queryResult(
      [
        { name: 'GROUP#', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'MEMBERS', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
        { name: 'SEQUENCE#', dataType: oracleNumber(10) },
      ],
      groups.map(g => [g.group, g.sizeBytes, g.members.length, g.status, g.sequence])
    );
  }

  private vLogfile(): ResultSet {
    const groups = this.instance.getRedoLogGroups();
    const rows: (string | number)[][] = [];
    for (const g of groups) {
      for (const m of g.members) {
        rows.push([g.group, m, 'ONLINE', g.status]);
      }
    }
    return queryResult(
      [
        { name: 'GROUP#', dataType: oracleNumber(10) },
        { name: 'MEMBER', dataType: oracleVarchar2(513) },
        { name: 'TYPE', dataType: oracleVarchar2(7) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
      ],
      rows
    );
  }

  private vProcess(): ResultSet {
    const procs = this.instance.getBackgroundProcesses();
    return queryResult(
      [
        { name: 'SPID', dataType: oracleNumber(10) },
        { name: 'PNAME', dataType: oracleVarchar2(5) },
        { name: 'DESCRIPTION', dataType: oracleVarchar2(64) },
      ],
      procs.map(p => [p.pid, p.name, p.description])
    );
  }

  private vControlfile(): ResultSet {
    const ctlFiles = (this.instance.getParameter('control_files') ?? '').split(',').map(f => f.trim());
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
      ],
      ctlFiles.map(f => [f, 'VALID'])
    );
  }

  private vDiagInfo(): ResultSet {
    const sid = ORACLE_CONFIG.SID;
    const base = ORACLE_CONFIG.BASE;
    const diagBase = `${base}/diag/rdbms/${sid.toLowerCase()}/${sid}`;
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
      ],
      [
        ['Diag Trace', `${diagBase}/trace`],
        ['Diag Alert', `${diagBase}/trace`],
        ['Diag Incident', `${diagBase}/incident`],
        ['ADR Base', base],
        ['ADR Home', diagBase],
      ]
    );
  }

  private vSgastat(): ResultSet {
    const sga = this.instance.getSGAInfo();
    return queryResult(
      [
        { name: 'POOL', dataType: oracleVarchar2(26) },
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'BYTES', dataType: oracleNumber(20) },
      ],
      [
        ['shared pool', 'library cache', 64 * 1024 * 1024],
        ['shared pool', 'dictionary cache', 32 * 1024 * 1024],
        ['shared pool', 'sql area', 48 * 1024 * 1024],
        ['shared pool', 'free memory', 16 * 1024 * 1024],
        ['java pool', 'free memory', 16 * 1024 * 1024],
        ['large pool', 'free memory', 16 * 1024 * 1024],
        [null, 'buffer_cache', 128 * 1024 * 1024],
        [null, 'log_buffer', 8 * 1024 * 1024],
        [null, 'fixed_sga', 2 * 1024 * 1024],
      ]
    );
  }

  private vLock(): ResultSet {
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'TYPE', dataType: oracleVarchar2(2) },
        { name: 'ID1', dataType: oracleNumber(20) },
        { name: 'ID2', dataType: oracleNumber(20) },
        { name: 'LMODE', dataType: oracleNumber(10) },
        { name: 'REQUEST', dataType: oracleNumber(10) },
        { name: 'BLOCK', dataType: oracleNumber(10) },
      ],
      [] // No active locks in simulator
    );
  }

  private vLockedObject(): ResultSet {
    return queryResult(
      [
        { name: 'XIDUSN', dataType: oracleNumber(10) },
        { name: 'XIDSLOT', dataType: oracleNumber(10) },
        { name: 'XIDSQN', dataType: oracleNumber(10) },
        { name: 'OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'SESSION_ID', dataType: oracleNumber(10) },
        { name: 'ORACLE_USERNAME', dataType: oracleVarchar2(30) },
        { name: 'LOCKED_MODE', dataType: oracleNumber(10) },
      ],
      []
    );
  }

  private vTransaction(): ResultSet {
    return queryResult(
      [
        { name: 'ADDR', dataType: oracleVarchar2(16) },
        { name: 'XIDUSN', dataType: oracleNumber(10) },
        { name: 'XIDSLOT', dataType: oracleNumber(10) },
        { name: 'XIDSQN', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(16) },
        { name: 'START_TIME', dataType: oracleVarchar2(20) },
        { name: 'USED_UBLK', dataType: oracleNumber(10) },
        { name: 'USED_UREC', dataType: oracleNumber(10) },
      ],
      []
    );
  }

  private vSql(): ResultSet {
    return queryResult(
      [
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'SQL_TEXT', dataType: oracleVarchar2(1000) },
        { name: 'EXECUTIONS', dataType: oracleNumber(20) },
        { name: 'ELAPSED_TIME', dataType: oracleNumber(20) },
        { name: 'CPU_TIME', dataType: oracleNumber(20) },
        { name: 'BUFFER_GETS', dataType: oracleNumber(20) },
        { name: 'DISK_READS', dataType: oracleNumber(20) },
        { name: 'ROWS_PROCESSED', dataType: oracleNumber(20) },
        { name: 'PARSING_SCHEMA_NAME', dataType: oracleVarchar2(30) },
        { name: 'FIRST_LOAD_TIME', dataType: oracleVarchar2(19) },
      ],
      [
        ['abc123def45', 'SELECT 1 FROM DUAL', 1, 100, 50, 1, 0, 1, 'SYS', new Date().toISOString().slice(0, 19)],
      ]
    );
  }

  private vSqlarea(): ResultSet {
    return queryResult(
      [
        { name: 'SQL_TEXT', dataType: oracleVarchar2(1000) },
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'VERSION_COUNT', dataType: oracleNumber(10) },
        { name: 'EXECUTIONS', dataType: oracleNumber(20) },
        { name: 'SORTS', dataType: oracleNumber(20) },
        { name: 'DISK_READS', dataType: oracleNumber(20) },
        { name: 'BUFFER_GETS', dataType: oracleNumber(20) },
        { name: 'ROWS_PROCESSED', dataType: oracleNumber(20) },
      ],
      []
    );
  }

  private vSysstat(): ResultSet {
    return queryResult(
      [
        { name: 'STATISTIC#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'CLASS', dataType: oracleNumber(10) },
        { name: 'VALUE', dataType: oracleNumber(20) },
      ],
      [
        [0, 'logons cumulative', 1, 5],
        [1, 'logons current', 1, 1],
        [2, 'opened cursors cumulative', 1, 10],
        [3, 'opened cursors current', 1, 1],
        [4, 'user commits', 1, 0],
        [5, 'user rollbacks', 1, 0],
        [6, 'user calls', 1, 1],
        [7, 'recursive calls', 1, 100],
        [8, 'session logical reads', 1, 500],
        [9, 'physical reads', 1, 10],
        [10, 'physical writes', 1, 5],
        [11, 'redo size', 1, 1024],
        [12, 'sorts (memory)', 1, 10],
        [13, 'sorts (disk)', 1, 0],
        [14, 'table scan rows gotten', 1, 200],
        [15, 'table scans (short tables)', 1, 5],
        [16, 'parse count (total)', 1, 15],
        [17, 'parse count (hard)', 1, 5],
        [18, 'execute count', 1, 20],
        [19, 'bytes sent via SQL*Net to client', 1, 4096],
        [20, 'bytes received via SQL*Net from client', 1, 2048],
      ]
    );
  }

  private vSesstat(currentUser: string): ResultSet {
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'STATISTIC#', dataType: oracleNumber(10) },
        { name: 'VALUE', dataType: oracleNumber(20) },
      ],
      [
        [10, 0, 1],   // logons cumulative
        [10, 4, 0],   // user commits
        [10, 5, 0],   // user rollbacks
        [10, 6, 1],   // user calls
        [10, 8, 50],  // session logical reads
      ]
    );
  }

  private vOpenCursor(currentUser: string): ResultSet {
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'USER_NAME', dataType: oracleVarchar2(30) },
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'SQL_TEXT', dataType: oracleVarchar2(60) },
        { name: 'CURSOR_TYPE', dataType: oracleVarchar2(64) },
      ],
      [
        [10, currentUser.toUpperCase(), 'abc123def45', 'SELECT 1 FROM DUAL', 'OPEN'],
      ]
    );
  }

  private vTempfile(): ResultSet {
    const tss = this.storage.getAllTablespaces();
    const rows: (string | number)[][] = [];
    let fileNum = 1;
    for (const ts of tss) {
      if (ts.type !== 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        rows.push([fileNum++, df.path, ts.name, df.size, df.autoextend ? 'YES' : 'NO']);
      }
    }
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'TS#_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleVarchar2(20) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  }

  private vArchivedLog(): ResultSet {
    return queryResult(
      [
        { name: 'RECID', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(513) },
        { name: 'SEQUENCE#', dataType: oracleNumber(10) },
        { name: 'FIRST_TIME', dataType: oracleDate() },
        { name: 'NEXT_TIME', dataType: oracleDate() },
        { name: 'ARCHIVED', dataType: oracleVarchar2(3) },
        { name: 'DELETED', dataType: oracleVarchar2(3) },
        { name: 'STATUS', dataType: oracleVarchar2(1) },
      ],
      this.instance.archiveLogMode ? [
        [1, '/u01/app/oracle/fast_recovery_area/ORCL/archivelog/arc_0001.arc', 1, new Date().toISOString(), new Date().toISOString(), 'YES', 'NO', 'A'],
      ] : []
    );
  }

  private vRecoverFile(): ResultSet {
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'ONLINE_STATUS', dataType: oracleVarchar2(7) },
        { name: 'ERROR', dataType: oracleVarchar2(18) },
        { name: 'CHANGE#', dataType: oracleNumber(20) },
        { name: 'TIME', dataType: oracleDate() },
      ],
      [] // No files needing recovery
    );
  }

  private vBackup(): ResultSet {
    const tss = this.storage.getAllTablespaces();
    const rows: (string | number)[][] = [];
    let fileNum = 1;
    for (const ts of tss) {
      for (const _df of ts.datafiles) {
        rows.push([fileNum++, 'NOT ACTIVE', 0, null as any, null as any]);
      }
    }
    return queryResult(
      [
        { name: 'FILE#', dataType: oracleNumber(10) },
        { name: 'STATUS', dataType: oracleVarchar2(18) },
        { name: 'CHANGE#', dataType: oracleNumber(20) },
        { name: 'TIME', dataType: oracleDate() },
        { name: 'COMPLETION_TIME', dataType: oracleDate() },
      ],
      rows
    );
  }

  private vOption(): ResultSet {
    return queryResult(
      [
        { name: 'PARAMETER', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(64) },
      ],
      [
        ['Partitioning', 'TRUE'],
        ['Objects', 'TRUE'],
        ['Real Application Clusters', 'FALSE'],
        ['Advanced replication', 'TRUE'],
        ['Bit-mapped indexes', 'TRUE'],
        ['Connection multiplexing', 'TRUE'],
        ['Connection pooling', 'TRUE'],
        ['Database queuing', 'TRUE'],
        ['Incremental backup and recovery', 'TRUE'],
        ['Instead-of triggers', 'TRUE'],
        ['Parallel backup and recovery', 'TRUE'],
        ['Parallel execution', 'TRUE'],
        ['Parallel load', 'TRUE'],
        ['Plan Stability', 'TRUE'],
        ['Point-in-time tablespace recovery', 'TRUE'],
        ['Server flash cache', 'TRUE'],
        ['Spatial', 'TRUE'],
        ['Transparent Data Encryption', 'TRUE'],
      ]
    );
  }

  private vNlsParameters(): ResultSet {
    return queryResult(
      [
        { name: 'PARAMETER', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(64) },
      ],
      [
        ['NLS_LANGUAGE', 'AMERICAN'],
        ['NLS_TERRITORY', 'AMERICA'],
        ['NLS_CURRENCY', '$'],
        ['NLS_ISO_CURRENCY', 'AMERICA'],
        ['NLS_NUMERIC_CHARACTERS', '.,'],
        ['NLS_CHARACTERSET', 'AL32UTF8'],
        ['NLS_CALENDAR', 'GREGORIAN'],
        ['NLS_DATE_FORMAT', 'DD-MON-RR'],
        ['NLS_DATE_LANGUAGE', 'AMERICAN'],
        ['NLS_SORT', 'BINARY'],
        ['NLS_COMP', 'BINARY'],
        ['NLS_TIMESTAMP_FORMAT', 'DD-MON-RR HH.MI.SSXFF AM'],
        ['NLS_TIME_FORMAT', 'HH.MI.SSXFF AM'],
        ['NLS_NCHAR_CHARACTERSET', 'AL16UTF16'],
        ['NLS_LENGTH_SEMANTICS', 'BYTE'],
      ]
    );
  }

  private vTimezoneNames(): ResultSet {
    return queryResult(
      [
        { name: 'TZNAME', dataType: oracleVarchar2(64) },
        { name: 'TZABBREV', dataType: oracleVarchar2(10) },
      ],
      [
        ['US/Eastern', 'EST'], ['US/Central', 'CST'], ['US/Mountain', 'MST'],
        ['US/Pacific', 'PST'], ['Europe/London', 'GMT'], ['Europe/Paris', 'CET'],
        ['Asia/Tokyo', 'JST'], ['Australia/Sydney', 'AEST'], ['UTC', 'UTC'],
      ]
    );
  }

  private vPgaTargetAdvice(): ResultSet {
    const pgaTarget = parseInt(this.instance.getParameter('pga_aggregate_target') ?? '256') * 1024 * 1024;
    return queryResult(
      [
        { name: 'PGA_TARGET_FOR_ESTIMATE', dataType: oracleNumber(20) },
        { name: 'PGA_TARGET_FACTOR', dataType: oracleNumber(10, 2) },
        { name: 'ESTD_PGA_CACHE_HIT_PERCENTAGE', dataType: oracleNumber(10) },
        { name: 'ESTD_OVERALLOC_COUNT', dataType: oracleNumber(10) },
      ],
      [
        [pgaTarget * 0.25, 0.25, 55, 5],
        [pgaTarget * 0.5, 0.5, 72, 2],
        [pgaTarget * 0.75, 0.75, 89, 0],
        [pgaTarget, 1.0, 100, 0],
        [pgaTarget * 1.5, 1.5, 100, 0],
        [pgaTarget * 2.0, 2.0, 100, 0],
      ]
    );
  }

  private vSqlPlan(): ResultSet {
    return queryResult(
      [
        { name: 'SQL_ID', dataType: oracleVarchar2(13) },
        { name: 'PLAN_HASH_VALUE', dataType: oracleNumber(20) },
        { name: 'CHILD_NUMBER', dataType: oracleNumber(10) },
        { name: 'OPERATION', dataType: oracleVarchar2(30) },
        { name: 'OPTIONS', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'COST', dataType: oracleNumber(20) },
        { name: 'CARDINALITY', dataType: oracleNumber(20) },
        { name: 'BYTES', dataType: oracleNumber(20) },
      ],
      []
    );
  }

  private vResourceLimit(): ResultSet {
    return queryResult(
      [
        { name: 'RESOURCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'CURRENT_UTILIZATION', dataType: oracleNumber(10) },
        { name: 'MAX_UTILIZATION', dataType: oracleNumber(10) },
        { name: 'INITIAL_ALLOCATION', dataType: oracleVarchar2(10) },
        { name: 'LIMIT_VALUE', dataType: oracleVarchar2(10) },
      ],
      [
        ['processes', 5, 5, '300', '300'],
        ['sessions', 1, 1, '472', '472'],
        ['enqueue_locks', 0, 0, '5588', '5588'],
        ['enqueue_resources', 0, 0, '2516', 'UNLIMITED'],
        ['ges_procs', 0, 0, '0', '0'],
        ['max_shared_servers', 0, 0, 'UNLIMITED', 'UNLIMITED'],
        ['parallel_max_servers', 0, 0, '40', '40'],
      ]
    );
  }

  private vAsmDiskgroup(): ResultSet {
    return queryResult(
      [
        { name: 'GROUP_NUMBER', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'SECTOR_SIZE', dataType: oracleNumber(10) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
        { name: 'ALLOCATION_UNIT_SIZE', dataType: oracleNumber(20) },
        { name: 'STATE', dataType: oracleVarchar2(11) },
        { name: 'TYPE', dataType: oracleVarchar2(6) },
        { name: 'TOTAL_MB', dataType: oracleNumber(20) },
        { name: 'FREE_MB', dataType: oracleNumber(20) },
      ],
      [
        [1, 'DATA', 512, 4096, 1048576, 'MOUNTED', 'EXTERN', 102400, 81920],
        [2, 'FRA', 512, 4096, 1048576, 'MOUNTED', 'EXTERN', 51200, 40960],
      ]
    );
  }

  // ── DBA_ views ───────────────────────────────────────────────────

  private queryDBA(viewName: string, _currentUser: string): ResultSet | null {
    switch (viewName) {
      case 'DBA_USERS': return this.dbaUsers();
      case 'DBA_ROLES': return this.dbaRoles();
      case 'DBA_ROLE_PRIVS': return this.dbaRolePrivs();
      case 'DBA_SYS_PRIVS': return this.dbaSysPrivs();
      case 'DBA_TABLES': return this.dbaTables();
      case 'DBA_TAB_COLUMNS': return this.dbaTabColumns();
      case 'DBA_OBJECTS': return this.dbaObjects();
      case 'DBA_TABLESPACES': return this.dbaTablespaces();
      case 'DBA_DATA_FILES': return this.dbaDataFiles();
      case 'DBA_INDEXES': return this.dbaIndexes();
      case 'DBA_CONSTRAINTS': return this.dbaConstraints();
      case 'DBA_SEQUENCES': return this.dbaSequences();
      case 'DBA_VIEWS': return this.dbaViews();
      case 'DBA_IND_COLUMNS': return this.dbaIndColumns();
      case 'DBA_CONS_COLUMNS': return this.dbaConsColumns();
      case 'DBA_TAB_PRIVS': return this.dbaTabPrivs();
      case 'DBA_SOURCE': return this.dbaSource();
      case 'DBA_PROCEDURES': return this.dbaProcedures();
      case 'DBA_TRIGGERS': return this.dbaTriggers();
      case 'DBA_TEMP_FILES': return this.dbaTempFiles();
      case 'DBA_FREE_SPACE': return this.dbaFreeSpace();
      case 'DBA_SEGMENTS': return this.dbaSegments();
      case 'DBA_EXTENTS': return this.dbaExtents();
      case 'DBA_AUDIT_TRAIL': return this.dbaAuditTrail();
      case 'DBA_STMT_AUDIT_OPTS': return this.dbaStmtAuditOpts();
      // DBA_AUDIT_SESSION, DBA_AUDIT_OBJECT, DBA_AUDIT_STATEMENT are
      // served by registered views under `views/dba_audit_*.ts`.
      case 'DBA_PROFILES': return this.dbaProfiles();
      case 'DBA_TS_QUOTAS': return this.dbaTsQuotas();
      case 'DBA_TAB_STATISTICS': return this.dbaTabStatistics();
      case 'DBA_DIRECTORIES': return this.dbaDirectories();
      case 'DBA_DB_LINKS': return this.dbaDbLinks();
      case 'DBA_JOBS': return this.dbaJobs();
      case 'DBA_SCHEDULER_JOBS': return this.dbaSchedulerJobs();
      case 'DBA_SYNONYMS': return this.dbaSynonyms();
      default: {
        const fromRegistry = queryView(viewName, {
          instance: this.instance,
          storage: this.storage,
          runtime: this.instance.getRuntimeState(),
          catalog: this,
          currentUser: _currentUser,
        });
        return fromRegistry ?? null; // Unknown view — fall through to table lookup
      }
    }
  }

  private dbaUsers(): ResultSet {
    const users = this.getAllUsers();
    const engine = this.securityEngine;

    return queryResult(
      [
        { name: 'USERNAME', dataType: oracleVarchar2(128) },
        { name: 'USER_ID', dataType: oracleNumber(10) },
        { name: 'ACCOUNT_STATUS', dataType: oracleVarchar2(32) },
        { name: 'LOCK_DATE', dataType: oracleDate() },
        { name: 'EXPIRY_DATE', dataType: oracleDate() },
        { name: 'DEFAULT_TABLESPACE', dataType: oracleVarchar2(30) },
        { name: 'TEMPORARY_TABLESPACE', dataType: oracleVarchar2(30) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'PROFILE', dataType: oracleVarchar2(128) },
        { name: 'AUTHENTICATION_TYPE', dataType: oracleVarchar2(8) },
      ],
      users.map(u => {
        // Compute live expiry date from PasswordManager
        let expiryDate: Date | null = u.expiryDate;
        let accountStatus: string = u.accountStatus;

        if (engine) {
          const lifetimeDays = engine.profiles.resolvePasswordLifetimeDays(u.profile);
          expiryDate = engine.passwords.computeExpiryDate(u.username, lifetimeDays);

          // Derive authoritative account status from actual state
          const isLocked = u.accountStatus === 'LOCKED' || u.accountStatus === 'EXPIRED & LOCKED';
          const pwStatus = engine.passwords.getPasswordStatus(
            u.username,
            lifetimeDays,
            engine.profiles.resolvePasswordGraceDays(u.profile)
          );
          const isExpired = pwStatus === 'EXPIRED' || pwStatus === 'EXPIRED(GRACE)';

          if (isLocked && isExpired) {
            accountStatus = 'EXPIRED & LOCKED';
          } else if (isLocked) {
            accountStatus = 'LOCKED';
          } else if (isExpired) {
            accountStatus = pwStatus === 'EXPIRED(GRACE)' ? 'EXPIRED(GRACE)' : 'EXPIRED';
          } else {
            accountStatus = 'OPEN';
          }
        }

        return [
          u.username,
          u.userId,
          accountStatus,
          u.lockDate ? u.lockDate.toISOString() : null,
          expiryDate ? expiryDate.toISOString() : null,
          u.defaultTablespace,
          u.temporaryTablespace,
          u.created.toISOString(),
          u.profile,
          u.authenticationType,
        ];
      })
    );
  }

  private dbaRoles(): ResultSet {
    const roles = this.getAllRoles();
    return queryResult(
      [
        { name: 'ROLE', dataType: oracleVarchar2(30) },
        { name: 'PASSWORD_REQUIRED', dataType: oracleVarchar2(8) },
      ],
      roles.map(r => [r.name, r.passwordRequired ? 'YES' : 'NO'])
    );
  }

  private dbaRolePrivs(): ResultSet {
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(30) },
        { name: 'GRANTED_ROLE', dataType: oracleVarchar2(30) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
      ],
      this.roleGrants.map(rg => [rg.grantee, rg.role, rg.adminOption ? 'YES' : 'NO'])
    );
  }

  private dbaSysPrivs(): ResultSet {
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(30) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'ADMIN_OPTION', dataType: oracleVarchar2(3) },
      ],
      this.sysPrivileges.map(p => [p.grantee, p.privilege, p.grantable ? 'YES' : 'NO'])
    );
  }

  private dbaTables(): ResultSet {
    const tables = this.storage.getAllTables();
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'NUM_ROWS', dataType: oracleNumber(20) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      tables.map(t => [t.schema, t.name, t.tablespace ?? 'USERS', t.rowCount, 'VALID'])
    );
  }

  private dbaTabColumns(): ResultSet {
    const tables = this.storage.getAllTables();
    const rows: (string | number | null)[][] = [];
    for (const t of tables) {
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
  }

  private dbaObjects(): ResultSet {
    const rows = this.enumerateObjects().map(o => [
      o.owner, o.name, o.subobject, o.objectId, o.dataObjectId,
      o.type, o.created.toISOString(), o.lastDdl.toISOString(),
      o.timestamp, o.status, o.temporary, o.generated, o.secondary,
      o.namespace, o.oracleMaintained,
    ]);
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'SUBOBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'DATA_OBJECT_ID', dataType: oracleNumber(10) },
        { name: 'OBJECT_TYPE', dataType: oracleVarchar2(23) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'LAST_DDL_TIME', dataType: oracleDate() },
        { name: 'TIMESTAMP', dataType: oracleVarchar2(19) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
        { name: 'TEMPORARY', dataType: oracleVarchar2(1) },
        { name: 'GENERATED', dataType: oracleVarchar2(1) },
        { name: 'SECONDARY', dataType: oracleVarchar2(1) },
        { name: 'NAMESPACE', dataType: oracleNumber(10) },
        { name: 'ORACLE_MAINTAINED', dataType: oracleVarchar2(1) },
      ],
      rows
    );
  }

  /**
   * Single source of truth for all database objects. DBA_OBJECTS,
   * ALL_OBJECTS, USER_OBJECTS, TAB and CAT all share the same
   * enumeration; the views differ only in filtering.
   */
  private enumerateObjects(): Array<{
    owner: string; name: string; subobject: string | null;
    objectId: number; dataObjectId: number | null;
    type: string; created: Date; lastDdl: Date;
    timestamp: string; status: 'VALID' | 'INVALID';
    temporary: 'Y' | 'N'; generated: 'Y' | 'N'; secondary: 'N';
    namespace: number; oracleMaintained: 'Y' | 'N';
  }> {
    const SYS_SCHEMAS = new Set(['SYS', 'SYSTEM', 'XDB', 'OUTLN', 'WMSYS', 'CTXSYS', 'MDSYS', 'ORDSYS', 'DBSNMP']);
    const ts = (d: Date) => d.toISOString().replace('T', ':').slice(0, 19);
    const seenIds = new Set<number>();
    const allocId = (seed: number) => { let v = seed; while (seenIds.has(v)) v++; seenIds.add(v); return v; };
    const out: ReturnType<typeof this.enumerateObjects> = [];
    let nextId = 1000;

    // Built-in catalog views — SYS-owned, marked ORACLE_MAINTAINED.
    // Use the instance's runtime startedAt as the creation timestamp so
    // it matches V$INSTANCE.STARTUP_TIME on a real database.
    const builtinCreated = new Date(this.instance.getRuntimeState().startedAt);
    let viewIdx = 0;
    for (const v of this.mergedCatalogViews().values()) {
      const created = builtinCreated;
      out.push({
        owner: 'SYS', name: v.name, subobject: null,
        objectId: allocId(100 + viewIdx++), dataObjectId: null,
        type: 'VIEW', created, lastDdl: created,
        timestamp: ts(created), status: 'VALID',
        temporary: 'N', generated: 'N', secondary: 'N',
        namespace: 1, oracleMaintained: 'Y',
      });
    }

    // Tables.
    for (const t of this.storage.getAllTables()) {
      const created = new Date();
      const id = allocId(nextId++);
      out.push({
        owner: t.schema, name: t.name, subobject: null,
        objectId: id, dataObjectId: id,
        type: 'TABLE', created, lastDdl: created,
        timestamp: ts(created), status: 'VALID',
        temporary: t.temporary ? 'Y' : 'N', generated: 'N', secondary: 'N',
        namespace: 1, oracleMaintained: SYS_SCHEMAS.has(t.schema) ? 'Y' : 'N',
      });
    }

    // User-defined views.
    for (const v of this.storage.getAllViews()) {
      const created = new Date();
      out.push({
        owner: v.schema, name: v.name, subobject: null,
        objectId: allocId(nextId++), dataObjectId: null,
        type: 'VIEW', created, lastDdl: created,
        timestamp: ts(created), status: 'VALID',
        temporary: 'N', generated: 'N', secondary: 'N',
        namespace: 1, oracleMaintained: SYS_SCHEMAS.has(v.schema) ? 'Y' : 'N',
      });
    }

    // Indexes.
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        const created = new Date();
        const id = allocId(nextId++);
        out.push({
          owner: schema, name: idx.name, subobject: null,
          objectId: id, dataObjectId: id,
          type: 'INDEX', created, lastDdl: created,
          timestamp: ts(created), status: 'VALID',
          temporary: 'N', generated: 'N', secondary: 'N',
          namespace: 4, oracleMaintained: SYS_SCHEMAS.has(schema) ? 'Y' : 'N',
        });
      }
    }

    // Sequences.
    for (const schema of this.storage.getSchemas()) {
      // BaseStorage exposes sequences indirectly — use getSequence per name
      // by trying known names from getTableNames. To stay correct we expose
      // them via a public helper if available, otherwise skip silently.
      const seqs = (this.storage as unknown as { sequences?: Map<string, Map<string, unknown>> }).sequences;
      const map = seqs?.get(schema);
      if (!map) continue;
      for (const seqName of map.keys()) {
        const created = new Date();
        out.push({
          owner: schema, name: seqName, subobject: null,
          objectId: allocId(nextId++), dataObjectId: null,
          type: 'SEQUENCE', created, lastDdl: created,
          timestamp: ts(created), status: 'VALID',
          temporary: 'N', generated: 'N', secondary: 'N',
          namespace: 1, oracleMaintained: SYS_SCHEMAS.has(schema) ? 'Y' : 'N',
        });
      }
    }

    // Synonyms.
    for (const s of this.storage.getAllSynonyms()) {
      const created = new Date();
      out.push({
        owner: s.owner, name: s.name, subobject: null,
        objectId: allocId(nextId++), dataObjectId: null,
        type: 'SYNONYM', created, lastDdl: created,
        timestamp: ts(created), status: 'VALID',
        temporary: 'N', generated: 'N', secondary: 'N',
        namespace: 1, oracleMaintained: s.owner === 'PUBLIC' || SYS_SCHEMAS.has(s.owner) ? 'Y' : 'N',
      });
    }

    // Triggers.
    for (const t of this.storage.getAllTriggers()) {
      const created = new Date();
      out.push({
        owner: t.schema, name: t.name, subobject: null,
        objectId: allocId(nextId++), dataObjectId: null,
        type: 'TRIGGER', created, lastDdl: created,
        timestamp: ts(created), status: 'VALID',
        temporary: 'N', generated: 'N', secondary: 'N',
        namespace: 1, oracleMaintained: SYS_SCHEMAS.has(t.schema) ? 'Y' : 'N',
      });
    }

    // Stored PL/SQL units.
    const units = this.storedUnitsProvider?.() ?? [];
    for (const u of units) {
      out.push({
        owner: u.schema, name: u.name, subobject: null,
        objectId: allocId(nextId++), dataObjectId: null,
        type: u.type, created: u.created, lastDdl: u.created,
        timestamp: ts(u.created), status: u.status,
        temporary: 'N', generated: 'N', secondary: 'N',
        namespace: 1, oracleMaintained: SYS_SCHEMAS.has(u.schema) ? 'Y' : 'N',
      });
    }
    return out;
  }

  private dbaTablespaces(): ResultSet {
    const tss = this.storage.getAllTablespaces();
    return queryResult(
      [
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(9) },
        { name: 'CONTENTS', dataType: oracleVarchar2(9) },
        { name: 'BLOCK_SIZE', dataType: oracleNumber(10) },
      ],
      tss.map(ts => [ts.name, ts.status, ts.type, ts.blockSize])
    );
  }

  private dbaDataFiles(): ResultSet {
    const tss = this.storage.getAllTablespaces();
    const rows: (string | number)[][] = [];
    let fileId = 1;
    for (const ts of tss) {
      if (ts.type === 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        rows.push([fileId++, df.path, ts.name, df.size, df.autoextend ? 'YES' : 'NO']);
      }
    }
    return queryResult(
      [
        { name: 'FILE_ID', dataType: oracleNumber(10) },
        { name: 'FILE_NAME', dataType: oracleVarchar2(513) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleVarchar2(20) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  }

  private dbaIndexes(): ResultSet {
    const rows: (string | number)[][] = [];
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        const isFunctionBased = idx.expressions?.some(e => e !== null) ?? false;
        const indexType = isFunctionBased ? 'FUNCTION-BASED NORMAL' : 'NORMAL';
        rows.push([schema, idx.name, idx.tableName, idx.unique ? 'UNIQUE' : 'NONUNIQUE', 'VALID', indexType]);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'INDEX_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'UNIQUENESS', dataType: oracleVarchar2(9) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
        { name: 'INDEX_TYPE', dataType: oracleVarchar2(27) },
      ],
      rows
    );
  }

  private dbaConstraints(): ResultSet {
    const tables = this.storage.getAllTables();
    const rows: (string | null)[][] = [];
    for (const t of tables) {
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
  }

  private dbaSequences(): ResultSet {
    const rows: (string | number | null)[][] = [];
    for (const schema of this.storage.getSchemas()) {
      const tableNames = this.storage.getTableNames(schema);
      // Sequences are separate but we check via storage
      // For now just return empty — will be enhanced
    }
    return queryResult(
      [
        { name: 'SEQUENCE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEQUENCE_NAME', dataType: oracleVarchar2(30) },
        { name: 'MIN_VALUE', dataType: oracleNumber(28) },
        { name: 'MAX_VALUE', dataType: oracleNumber(28) },
        { name: 'INCREMENT_BY', dataType: oracleNumber(28) },
        { name: 'LAST_NUMBER', dataType: oracleNumber(28) },
      ],
      rows
    );
  }

  /**
   * DBA_VIEWS — every view in the database, regardless of owner.
   *
   * Reports both user-defined views (from `OracleStorage.getAllViews`)
   * and the SYS-owned dictionary views surfaced via `BUILTIN_VIEWS`.
   * The full Oracle 19c column set is returned so tooling (sqldeveloper,
   * DBA scripts, our own DESC command) treats it the same way it would
   * on a real instance.
   */
  private dbaViews(): ResultSet {
    return queryResult(VIEW_COLUMNS, this.collectViewRows());
  }

  /**
   * Every SYS-owned dictionary / dynamic view the simulator exposes,
   * keyed by uppercase name. The self-registering view files (each
   * `registerView(...)` under `views/`) are the single source of truth:
   * registering a view automatically surfaces it in DBA_VIEWS /
   * ALL_VIEWS / USER_VIEWS / DBA_OBJECTS / DICTIONARY with no parallel
   * catalog entry to maintain.
   *
   * `BUILTIN_VIEWS` is merged in only to cover the handful of views
   * still served by hardcoded methods in this class (DBA_USERS,
   * V$SESSION, …) which are not self-registered. When a name exists in
   * both places the registered definition wins.
   */
  private mergedCatalogViews(): Map<string, CatalogViewEntry> {
    const merged = new Map<string, CatalogViewEntry>();
    for (const v of BUILTIN_VIEWS) {
      merged.set(v.name.toUpperCase(), { name: v.name.toUpperCase(), text: v.text, comment: v.comment });
    }
    // Registered views take precedence — everything about the view
    // (including its catalog text/comment) lives in its own file.
    for (const e of listCatalogViewEntries()) {
      merged.set(e.name, e);
    }
    return merged;
  }

  /**
   * Build the rows that back DBA_VIEWS / ALL_VIEWS / USER_VIEWS.
   * Reusing the same enumerator guarantees the three views stay
   * consistent — they differ only in filtering.
   */
  private collectViewRows(): (string | number | null)[][] {
    const rows: (string | number | null)[][] = [];

    // SYS-owned dictionary / dynamic views (registered + hardcoded).
    for (const v of this.mergedCatalogViews().values()) {
      rows.push(viewRow('SYS', v.name, v.text));
    }

    // User-defined views — text is the original CREATE VIEW query.
    for (const v of this.storage.getAllViews()) {
      const text = v.queryText ?? '';
      rows.push(viewRow(v.schema, v.name, text));
    }
    return rows;
  }

  private dbaIndColumns(): ResultSet {
    const rows: (string | number | null)[][] = [];
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        for (let i = 0; i < idx.columns.length; i++) {
          const expr = idx.expressions?.[i] ?? null;
          rows.push([schema, idx.name, idx.tableName, idx.columns[i], i + 1, expr]);
        }
      }
    }
    return queryResult(
      [
        { name: 'INDEX_OWNER', dataType: oracleVarchar2(30) },
        { name: 'INDEX_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_NAME', dataType: oracleVarchar2(30) },
        { name: 'COLUMN_POSITION', dataType: oracleNumber(10) },
        { name: 'COLUMN_EXPRESSION', dataType: oracleVarchar2(4000) },
      ],
      rows
    );
  }

  private dbaConsColumns(): ResultSet {
    const tables = this.storage.getAllTables();
    const rows: (string | null)[][] = [];
    for (const t of tables) {
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
  }

  private dbaTabPrivs(): ResultSet {
    const rows: (string | number | null)[][] = this.tabPrivileges.map(p => [
      p.grantee,
      p.objectSchema ?? 'SYS',
      p.objectName ?? '',
      p.privilege,
      p.grantable ? 'YES' : 'NO',
      'SYS', // GRANTOR — defaults to SYS in our simulation
      'OBJECT', // TYPE
    ]);
    return queryResult(
      [
        { name: 'GRANTEE', dataType: oracleVarchar2(128) },
        { name: 'OWNER', dataType: oracleVarchar2(128) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(128) },
        { name: 'PRIVILEGE', dataType: oracleVarchar2(40) },
        { name: 'GRANTABLE', dataType: oracleVarchar2(3) },
        { name: 'GRANTOR', dataType: oracleVarchar2(128) },
        { name: 'TYPE', dataType: oracleVarchar2(24) },
      ],
      rows
    );
  }

  private dbaSource(): ResultSet {
    const units = this.storedUnitsProvider?.() ?? [];
    const rows: (string | number)[][] = [];
    for (const u of units) {
      for (let i = 0; i < u.sourceLines.length; i++) {
        rows.push([u.schema, u.name, u.type, i + 1, u.sourceLines[i]]);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'TYPE', dataType: oracleVarchar2(12) },
        { name: 'LINE', dataType: oracleNumber(10) },
        { name: 'TEXT', dataType: oracleVarchar2(4000) },
      ],
      rows
    );
  }

  private dbaProcedures(): ResultSet {
    const units = this.storedUnitsProvider?.() ?? [];
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_TYPE', dataType: oracleVarchar2(13) },
        { name: 'AGGREGATE', dataType: oracleVarchar2(3) },
        { name: 'PIPELINED', dataType: oracleVarchar2(3) },
        { name: 'DETERMINISTIC', dataType: oracleVarchar2(3) },
      ],
      units.filter(u => u.type === 'PROCEDURE' || u.type === 'FUNCTION')
           .map(u => [u.schema, u.name, u.type, 'NO', 'NO', 'NO'])
    );
  }

  private dbaTriggers(): ResultSet {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TRIGGER_NAME', dataType: oracleVarchar2(30) },
        { name: 'TRIGGER_TYPE', dataType: oracleVarchar2(16) },
        { name: 'TRIGGERING_EVENT', dataType: oracleVarchar2(227) },
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
      ],
      []
    );
  }

  private dbaTempFiles(): ResultSet {
    const tss = this.storage.getAllTablespaces();
    const rows: (string | number)[][] = [];
    let fileId = 1;
    for (const ts of tss) {
      if (ts.type !== 'TEMPORARY') continue;
      for (const df of ts.datafiles) {
        rows.push([fileId++, df.path, ts.name, df.size, df.autoextend ? 'YES' : 'NO']);
      }
    }
    return queryResult(
      [
        { name: 'FILE_ID', dataType: oracleNumber(10) },
        { name: 'FILE_NAME', dataType: oracleVarchar2(513) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleVarchar2(20) },
        { name: 'AUTOEXTENSIBLE', dataType: oracleVarchar2(3) },
      ],
      rows
    );
  }

  private dbaFreeSpace(): ResultSet {
    const tss = this.storage.getAllTablespaces();
    const rows: (string | number)[][] = [];
    let fileId = 1;
    for (const ts of tss) {
      for (const df of ts.datafiles) {
        const freeBytes = Math.floor(parseInt(String(df.size)) * 0.7);
        rows.push([ts.name, fileId++, freeBytes, 1]);
      }
    }
    return queryResult(
      [
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'FILE_ID', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
      ],
      rows
    );
  }

  private dbaSegments(): ResultSet {
    const tables = this.storage.getAllTables();
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_TYPE', dataType: oracleVarchar2(18) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'EXTENTS', dataType: oracleNumber(10) },
      ],
      tables.map(t => [t.schema, t.name, 'TABLE', t.tablespace ?? 'USERS', t.rowCount * 200, Math.ceil(t.rowCount * 200 / 8192), 1])
    );
  }

  private dbaExtents(): ResultSet {
    const tables = this.storage.getAllTables();
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_NAME', dataType: oracleVarchar2(30) },
        { name: 'SEGMENT_TYPE', dataType: oracleVarchar2(18) },
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'EXTENT_ID', dataType: oracleNumber(10) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
      ],
      tables.map(t => [t.schema, t.name, 'TABLE', t.tablespace ?? 'USERS', 0, 65536, 8])
    );
  }

  private dbaAuditTrail(): ResultSet {
    return queryResult(
      [
        { name: 'OS_USERNAME', dataType: oracleVarchar2(255) },
        { name: 'USERNAME', dataType: oracleVarchar2(128) },
        { name: 'USERHOST', dataType: oracleVarchar2(128) },
        { name: 'TIMESTAMP', dataType: oracleDate() },
        { name: 'ACTION_NAME', dataType: oracleVarchar2(28) },
        { name: 'OBJ_NAME', dataType: oracleVarchar2(128) },
        { name: 'RETURNCODE', dataType: oracleNumber(10) },
        { name: 'OBJ_OWNER', dataType: oracleVarchar2(128) },
        { name: 'SESSIONID', dataType: oracleNumber(10) },
        { name: 'PRIV_USED', dataType: oracleVarchar2(40) },
        { name: 'SQL_TEXT', dataType: oracleVarchar2(2000) },
        { name: 'STATEMENT_TYPE', dataType: oracleVarchar2(28) },
      ],
      this.auditTrail.map(e => [
        e.osUsername,
        e.username,
        e.userhost,
        e.timestamp.toISOString(),
        e.actionName,
        e.objName,
        e.returncode,
        e.objOwner,
        e.sessionId,
        e.privUsed,
        e.sqlText,
        e.statementType,
      ])
    );
  }

  private dbaAuditSession(): ResultSet {
    // Pair LOGON entries with their matching LOGOFF (by sessionId) so
    // LOGOFF_TIME is populated for closed sessions and NULL for active ones.
    const logons = this.auditTrail.filter(e => e.actionName === 'LOGON');
    const logoffs = new Map<number, AuditEntry>();
    for (const e of this.auditTrail) {
      if (e.actionName === 'LOGOFF') logoffs.set(e.sessionId, e);
    }
    const rows = logons.map(e => {
      const off = logoffs.get(e.sessionId);
      return [
        e.osUsername, e.username, e.userhost, e.terminal,
        e.timestamp.toISOString(), 'LOGON', e.sessionId,
        off ? off.timestamp.toISOString() : null,
        e.returncode,
      ];
    });
    // Include LOGOFF rows too — Oracle's DBA_AUDIT_SESSION reports both.
    for (const off of logoffs.values()) {
      rows.push([
        off.osUsername, off.username, off.userhost, off.terminal,
        off.timestamp.toISOString(), 'LOGOFF', off.sessionId,
        off.timestamp.toISOString(),
        off.returncode,
      ]);
    }
    return queryResult(
      [
        { name: 'OS_USERNAME', dataType: oracleVarchar2(30) },
        { name: 'USERNAME', dataType: oracleVarchar2(128) },
        { name: 'USERHOST', dataType: oracleVarchar2(128) },
        { name: 'TERMINAL', dataType: oracleVarchar2(128) },
        { name: 'TIMESTAMP', dataType: oracleDate() },
        { name: 'ACTION_NAME', dataType: oracleVarchar2(28) },
        { name: 'SESSIONID', dataType: oracleNumber(10) },
        { name: 'LOGOFF_TIME', dataType: oracleDate() },
        { name: 'RETURNCODE', dataType: oracleNumber(10) },
      ],
      rows
    );
  }

  private dbaStmtAuditOpts(): ResultSet {
    return queryResult(
      [
        { name: 'USER_NAME', dataType: oracleVarchar2(128) },
        { name: 'AUDIT_OPTION', dataType: oracleVarchar2(40) },
        { name: 'SUCCESS', dataType: oracleVarchar2(10) },
        { name: 'FAILURE', dataType: oracleVarchar2(10) },
      ],
      this.stmtAuditOpts.map(o => [o.userName, o.auditOption, o.success, o.failure])
    );
  }

  /** All resource limits with their types for profile generation */
  private static readonly PROFILE_RESOURCES: [string, string, string][] = [
    ['COMPOSITE_LIMIT', 'KERNEL', 'UNLIMITED'],
    ['SESSIONS_PER_USER', 'KERNEL', 'UNLIMITED'],
    ['CPU_PER_SESSION', 'KERNEL', 'UNLIMITED'],
    ['CPU_PER_CALL', 'KERNEL', 'UNLIMITED'],
    ['LOGICAL_READS_PER_SESSION', 'KERNEL', 'UNLIMITED'],
    ['LOGICAL_READS_PER_CALL', 'KERNEL', 'UNLIMITED'],
    ['IDLE_TIME', 'KERNEL', 'UNLIMITED'],
    ['CONNECT_TIME', 'KERNEL', 'UNLIMITED'],
    ['PRIVATE_SGA', 'KERNEL', 'UNLIMITED'],
    ['FAILED_LOGIN_ATTEMPTS', 'PASSWORD', '10'],
    ['PASSWORD_LIFE_TIME', 'PASSWORD', '180'],
    ['PASSWORD_REUSE_TIME', 'PASSWORD', 'UNLIMITED'],
    ['PASSWORD_REUSE_MAX', 'PASSWORD', 'UNLIMITED'],
    ['PASSWORD_LOCK_TIME', 'PASSWORD', '1'],
    ['PASSWORD_GRACE_TIME', 'PASSWORD', '7'],
    ['PASSWORD_VERIFY_FUNCTION', 'PASSWORD', 'NULL'],
  ];

  private dbaProfiles(): ResultSet {
    const cols = [
      { name: 'PROFILE', dataType: oracleVarchar2(128) },
      { name: 'RESOURCE_NAME', dataType: oracleVarchar2(32) },
      { name: 'RESOURCE_TYPE', dataType: oracleVarchar2(8) },
      { name: 'LIMIT', dataType: oracleVarchar2(128) },
    ];

    // Prefer SecurityEngine's ProfileManager (authoritative)
    if (this.securityEngine) {
      const profileRows = this.securityEngine.profiles.getAllProfileRows();
      return queryResult(cols, profileRows.map(r => [r.profile, r.resourceName, r.resourceType, r.limit]));
    }

    // Legacy fallback (no SecurityEngine wired yet)
    const rows: (string | number | null)[][] = [];
    for (const [resName, resType, defaultLimit] of OracleCatalog.PROFILE_RESOURCES) {
      rows.push(['DEFAULT', resName, resType, defaultLimit]);
    }
    for (const [profileName, overrides] of this.profiles) {
      for (const [resName, resType] of OracleCatalog.PROFILE_RESOURCES) {
        const limit = overrides.get(resName) ?? 'DEFAULT';
        rows.push([profileName, resName, resType, limit]);
      }
    }
    return queryResult(cols, rows);
  }

  private dbaTsQuotas(): ResultSet {
    const cols = [
      { name: 'USERNAME', dataType: oracleVarchar2(128) },
      { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
      { name: 'BYTES', dataType: oracleNumber(20) },
      { name: 'MAX_BYTES', dataType: oracleNumber(20) },
      { name: 'BLOCKS', dataType: oracleNumber(20) },
      { name: 'MAX_BLOCKS', dataType: oracleNumber(20) },
      { name: 'DROPPED', dataType: oracleVarchar2(3) },
    ];
    if (!this.securityEngine) return queryResult(cols, []);
    const quotas = this.securityEngine.quotas.getAllQuotas();
    const blockSize = 8192;
    return queryResult(cols, quotas.map(q => {
      const maxBytes = q.maxBytes === -1 ? -1 : q.maxBytes;
      return [
        q.username, q.tablespace, q.bytesUsed, maxBytes,
        Math.ceil(q.bytesUsed / blockSize),
        maxBytes === -1 ? -1 : Math.ceil(maxBytes / blockSize),
        'NO',
      ];
    }));
  }

  private dbaTabStatistics(): ResultSet {
    const tables = this.storage.getAllTables();
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'NUM_ROWS', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'AVG_ROW_LEN', dataType: oracleNumber(20) },
        { name: 'LAST_ANALYZED', dataType: oracleDate() },
        { name: 'STALE_STATS', dataType: oracleVarchar2(3) },
      ],
      tables.map(t => [t.schema, t.name, t.rowCount, Math.ceil(t.rowCount * 200 / 8192), 200, new Date().toISOString(), 'NO'])
    );
  }

  private dbaDirectories(): ResultSet {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'DIRECTORY_NAME', dataType: oracleVarchar2(30) },
        { name: 'DIRECTORY_PATH', dataType: oracleVarchar2(4000) },
      ],
      [
        ['SYS', 'DATA_PUMP_DIR', '/u01/app/oracle/admin/ORCL/dpdump/'],
      ]
    );
  }

  private dbaDbLinks(): ResultSet {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'HOST', dataType: oracleVarchar2(2000) },
        { name: 'CREATED', dataType: oracleDate() },
      ],
      []
    );
  }

  private dbaJobs(): ResultSet {
    return queryResult(
      [
        { name: 'JOB', dataType: oracleNumber(10) },
        { name: 'LOG_USER', dataType: oracleVarchar2(30) },
        { name: 'SCHEMA_USER', dataType: oracleVarchar2(30) },
        { name: 'WHAT', dataType: oracleVarchar2(4000) },
        { name: 'NEXT_DATE', dataType: oracleDate() },
        { name: 'BROKEN', dataType: oracleVarchar2(1) },
      ],
      []
    );
  }

  private dbaSchedulerJobs(): ResultSet {
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'JOB_NAME', dataType: oracleVarchar2(30) },
        { name: 'JOB_TYPE', dataType: oracleVarchar2(16) },
        { name: 'STATE', dataType: oracleVarchar2(15) },
        { name: 'ENABLED', dataType: oracleVarchar2(5) },
        { name: 'NEXT_RUN_DATE', dataType: oracleDate() },
      ],
      []
    );
  }

  private dbaSynonyms(): ResultSet {
    const synonyms = this.storage.getAllSynonyms();
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'SYNONYM_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_OWNER', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'DB_LINK', dataType: oracleVarchar2(128) },
      ],
      synonyms.map(s => [s.owner, s.name, s.tableOwner, s.tableName, s.dbLink ?? null])
    );
  }

  // ── ALL_ views (user-accessible objects) ─────────────────────────

  private queryALL(viewName: string, currentUser: string): ResultSet | null {
    // ALL_VIEWS — every view accessible to the current user. In our
    // simulator, the catalog dictionary views are world-readable and
    // user-defined views are accessible to their owner. SYS sees all.
    if (viewName === 'ALL_VIEWS') {
      const upper = currentUser.toUpperCase();
      const rows = this.collectViewRows().filter(r => {
        const owner = String(r[0]).toUpperCase();
        return owner === 'SYS' || owner === upper;
      });
      return queryResult(VIEW_COLUMNS, rows);
    }

    // ALL_OBJECTS — same scoping as ALL_VIEWS.
    if (viewName === 'ALL_OBJECTS') {
      const dba = this.dbaObjects();
      const upper = currentUser.toUpperCase();
      dba.rows = dba.rows.filter(r => {
        const owner = String(r[0]).toUpperCase();
        return owner === 'SYS' || owner === upper || owner === 'PUBLIC';
      });
      return dba;
    }

    // ALL_ views show objects accessible to the current user
    // For simplicity, show same as DBA_ for now (will filter later)
    const dbaName = viewName.replace('ALL_', 'DBA_');
    return this.queryDBA(dbaName, currentUser);
  }

  // ── USER_ views (current user's objects) ─────────────────────────

  private queryUSER(viewName: string, currentUser: string): ResultSet | null {
    const upper = currentUser.toUpperCase();

    // USER_VIEWS — views owned by the current user. Note: USER_VIEWS
    // does NOT include the OWNER column (real Oracle drops it).
    if (viewName === 'USER_VIEWS') {
      const rows = this.collectViewRows()
        .filter(r => String(r[0]).toUpperCase() === upper)
        .map(r => r.slice(1)); // drop OWNER
      return queryResult(VIEW_COLUMNS.slice(1), rows);
    }

    // USER_OBJECTS — objects owned by the current user; drops OWNER.
    if (viewName === 'USER_OBJECTS') {
      const dba = this.dbaObjects();
      const ownerIdx = dba.columns.findIndex(c => c.name === 'OWNER');
      const filtered = dba.rows.filter(r => String(r[ownerIdx]).toUpperCase() === upper);
      const cols = dba.columns.filter((_, i) => i !== ownerIdx);
      const rows = filtered.map(r => r.filter((_, i) => i !== ownerIdx));
      return queryResult(cols, rows);
    }

    // Special cases for USER_ views that differ structurally from DBA_ equivalents
    if (viewName === 'USER_TS_QUOTAS') {
      if (!this.securityEngine) return queryResult([
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'MAX_BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'MAX_BLOCKS', dataType: oracleNumber(20) },
        { name: 'DROPPED', dataType: oracleVarchar2(3) },
      ], []);
      const quotas = this.securityEngine.quotas.getUserQuotas(currentUser);
      const blockSize = 8192;
      return queryResult([
        { name: 'TABLESPACE_NAME', dataType: oracleVarchar2(30) },
        { name: 'BYTES', dataType: oracleNumber(20) },
        { name: 'MAX_BYTES', dataType: oracleNumber(20) },
        { name: 'BLOCKS', dataType: oracleNumber(20) },
        { name: 'MAX_BLOCKS', dataType: oracleNumber(20) },
        { name: 'DROPPED', dataType: oracleVarchar2(3) },
      ], quotas.map(q => {
        const maxBytes = q.maxBytes === -1 ? -1 : q.maxBytes;
        return [q.tablespace, q.bytesUsed, maxBytes,
          Math.ceil(q.bytesUsed / blockSize),
          maxBytes === -1 ? -1 : Math.ceil(maxBytes / blockSize), 'NO'];
      }));
    }

    // USER_ views show objects owned by the current user
    const dbaName = viewName.replace('USER_', 'DBA_');
    const result = this.queryDBA(dbaName, currentUser);
    if (!result || !result.isQuery) return result;
    // Filter to current user's schema
    const ownerIdx = result.columns.findIndex(c => c.name === 'OWNER' || c.name === 'SEQUENCE_OWNER');
    if (ownerIdx >= 0) {
      result.rows = result.rows.filter(r => String(r[ownerIdx]).toUpperCase() === currentUser.toUpperCase());
    }
    return result;
  }

  // ── TAB / CAT ──────────────────────────────────────────────────

  private queryTabCat(currentUser: string): ResultSet {
    const tables = this.storage.getAllTables();
    const userTables = tables.filter(t => t.schema === currentUser.toUpperCase());
    return queryResult(
      [
        { name: 'TNAME', dataType: oracleVarchar2(30) },
        { name: 'TABTYPE', dataType: oracleVarchar2(7) },
      ],
      userTables.map(t => [t.name, 'TABLE'])
    );
  }

  // ── SYS internal tables ───────────────────────────────────────

  private querySysInternal(tableName: string): ResultSet | null {
    switch (tableName) {
      case 'OBJ$': return this.sysObj();
      case 'TAB$': return this.sysTab();
      case 'COL$': return this.sysCol();
      case 'IND$': return this.sysInd();
      case 'USER$': return this.sysUser();
      case 'TS$': return this.sysTs();
      case 'AUD$': return this.sysAud();
      default: return null;
    }
  }

  private sysObj(): ResultSet {
    const tables = this.storage.getAllTables();
    const views = this.storage.getAllViews();
    const rows: (string | number | null)[][] = [];
    let objId = 1000;
    for (const t of tables) {
      rows.push([objId++, t.schema, t.name, 2, 'TABLE', 'VALID', new Date().toISOString()]);
    }
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        rows.push([objId++, schema, idx.name, 1, 'INDEX', 'VALID', new Date().toISOString()]);
      }
    }
    for (const v of views) {
      rows.push([objId++, v.schema, v.name, 4, 'VIEW', 'VALID', new Date().toISOString()]);
    }
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'OWNER#', dataType: oracleVarchar2(30) },
        { name: 'NAME', dataType: oracleVarchar2(128) },
        { name: 'NAMESPACE', dataType: oracleNumber(10) },
        { name: 'TYPE#', dataType: oracleVarchar2(13) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
        { name: 'CTIME', dataType: oracleDate() },
      ],
      rows
    );
  }

  private sysTab(): ResultSet {
    const tables = this.storage.getAllTables();
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'COLS', dataType: oracleNumber(10) },
        { name: 'ROWCNT', dataType: oracleNumber(20) },
        { name: 'BLKCNT', dataType: oracleNumber(10) },
      ],
      tables.map((t, i) => [1000 + i, 0, t.columns.length, t.rowCount, Math.ceil(t.rowCount / 100)])
    );
  }

  private sysCol(): ResultSet {
    const tables = this.storage.getAllTables();
    const rows: (string | number | null)[][] = [];
    let objId = 1000;
    for (const t of tables) {
      for (const c of t.columns) {
        rows.push([objId, c.name, c.ordinalPosition + 1, c.dataType.name, c.dataType.precision ?? null, c.dataType.scale ?? null, c.dataType.nullable ? 'Y' : 'N']);
      }
      objId++;
    }
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(128) },
        { name: 'COL#', dataType: oracleNumber(10) },
        { name: 'TYPE#', dataType: oracleVarchar2(30) },
        { name: 'LENGTH', dataType: oracleNumber(10) },
        { name: 'SCALE', dataType: oracleNumber(10) },
        { name: 'NULL$', dataType: oracleVarchar2(1) },
      ],
      rows
    );
  }

  private sysInd(): ResultSet {
    const rows: (string | number)[][] = [];
    let i = 0;
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        rows.push([2000 + i, 1000, idx.unique ? 1 : 0, idx.columns.length, idx.unique ? 'UNIQUE' : 'NONUNIQUE']);
        i++;
      }
    }
    return queryResult(
      [
        { name: 'OBJ#', dataType: oracleNumber(10) },
        { name: 'BO#', dataType: oracleNumber(10) },
        { name: 'TYPE#', dataType: oracleNumber(10) },
        { name: 'COLS', dataType: oracleNumber(10) },
        { name: 'UNIQUENESS', dataType: oracleVarchar2(9) },
      ],
      rows
    );
  }

  private sysUser(): ResultSet {
    const users = this.getAllUsers();
    return queryResult(
      [
        { name: 'USER#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'TYPE#', dataType: oracleNumber(10) },
        { name: 'CTIME', dataType: oracleDate() },
      ],
      users.map((u, i) => [i + 1, u.username, 1, u.created.toISOString()])
    );
  }

  private sysTs(): ResultSet {
    const tablespaces = this.storage.getAllTablespaces();
    return queryResult(
      [
        { name: 'TS#', dataType: oracleNumber(10) },
        { name: 'NAME', dataType: oracleVarchar2(30) },
        { name: 'BLOCKSIZE', dataType: oracleNumber(10) },
        { name: 'STATUS$', dataType: oracleVarchar2(9) },
      ],
      tablespaces.map((ts, i) => [i, ts.name, ts.blockSize, 'ONLINE'])
    );
  }

  private sysAud(): ResultSet {
    // Map action names to Oracle action numbers
    const actionNumbers: Record<string, number> = {
      'CREATE TABLE': 1, 'INSERT': 2, 'SELECT': 3, 'CREATE ROLE': 52,
      'ALTER ROLE': 79, 'DROP ROLE': 54, 'CREATE USER': 51, 'ALTER USER': 43,
      'DROP USER': 53, 'GRANT': 17, 'REVOKE': 18, 'CREATE VIEW': 21,
      'DROP VIEW': 22, 'CREATE INDEX': 9, 'DROP INDEX': 10, 'DROP TABLE': 12,
      'ALTER TABLE': 15, 'CREATE SEQUENCE': 13, 'DROP SEQUENCE': 14,
      'CREATE TRIGGER': 59, 'CREATE PROCEDURE': 24, 'CREATE PROFILE': 65,
      'ALTER PROFILE': 67, 'DROP PROFILE': 66,
    };
    return queryResult(
      [
        { name: 'SESSIONID', dataType: oracleNumber(10) },
        { name: 'USERID', dataType: oracleVarchar2(128) },
        { name: 'ACTION#', dataType: oracleNumber(10) },
        { name: 'RETURNCODE', dataType: oracleNumber(10) },
        { name: 'TIMESTAMP#', dataType: oracleDate() },
        { name: 'OBJ$NAME', dataType: oracleVarchar2(128) },
        { name: 'OBJ$CREATOR', dataType: oracleVarchar2(128) },
        { name: 'SQLTEXT', dataType: oracleVarchar2(2000) },
      ],
      this.auditTrail.map(e => [
        e.sessionId,
        e.username,
        actionNumbers[e.actionName] ?? 0,
        e.returncode,
        e.timestamp.toISOString(),
        e.objName,
        e.objOwner,
        e.sqlText,
      ])
    );
  }

  // ── DICTIONARY view ──────────────────────────────────────────────

  private queryDictionary(): ResultSet {
    // Derived from the same merged catalog used by DBA_VIEWS — a
    // self-registered view automatically appears in DICTIONARY / DICT.
    const views = [...this.mergedCatalogViews().values()]
      .map(v => [v.name, v.comment ?? `${v.name} (catalog view)`] as [string, string])
      .sort((a, b) => a[0].localeCompare(b[0]));
    return queryResult(
      [
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COMMENTS', dataType: oracleVarchar2(4000) },
      ],
      views
    );
  }
}

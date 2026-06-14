/**
 * OracleCatalog — Oracle data dictionary implementation.
 *
 * Provides V$ dynamic performance views and DBA_/ALL_/USER_ dictionary views.
 * Queries against these views return simulated metadata from the storage layer.
 */

import { TableHistory } from './flashback/TableHistory';
import { BaseCatalog, type CatalogUser, type CatalogPrivilege } from '../engine/catalog/BaseCatalog';
import { type ResultSet, queryResult, emptyResult } from '../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../engine/catalog/DataType';
import type { OracleStorage } from './OracleStorage';
import type { OracleInstance } from './OracleInstance';
import { ORACLE_CONFIG } from './OracleConfig';
import { queryView, listCatalogViewEntries, type CatalogViewEntry } from './views/registry';
import { VIEW_COLUMNS } from './views/_viewColumns';
import { BUILTIN_VIEWS } from './views/builtinCatalog';
import type { SecurityEngine } from './security/SecurityEngine';
import { provisionClassicRoles, seedCatalogRoleObjectGrants } from './security/classicRoles';
import type { PlsqlCompilationError } from './plsql/unitSource';
import { deriveStoredVerifiers, type OracleStoredVerifiers } from './security/storedVerifier';
// Side-effect import: each file under `views/` self-registers its
// definition. Adding a new view requires only creating a new file there
// and adding it to `views/index.ts` — no edits to the catalog.
import './views';

/** Stored PL/SQL unit shape (avoids circular import with OracleDatabase) */
export interface StoredUnit {
  schema: string; name: string; type: string;
  parameters: Array<{ name: string; mode: string; dataType: string }>;
  returnType?: string; body: string; sourceLines: string[];
  created: Date; status: string;
}

export interface StoredUnitErrors {
  owner: string;
  name: string;
  type: string;
  errors: PlsqlCompilationError[];
}

/** A user-package member row (DBA_PROCEDURES source). */
export interface PackageMemberRow {
  schema: string;
  pkg: string;
  member: string;
  kind: 'PROCEDURE' | 'FUNCTION';
}

/** A single row produced by `enumerateObjects` (DBA_OBJECTS source). */
export interface EnumeratedObject {
  owner: string; name: string; subobject: string | null;
  objectId: number; dataObjectId: number | null;
  type: string; created: Date; lastDdl: Date;
  timestamp: string; status: 'VALID' | 'INVALID';
  temporary: 'Y' | 'N'; generated: 'Y' | 'N'; secondary: 'N';
  namespace: number; oracleMaintained: 'Y' | 'N';
}

/** Audit trail entry shape */
/**
 * One materialized view. The container table (rows) lives in storage
 * under the same owner/name; this is the dictionary side of the object.
 */
export interface MaterializedViewMeta {
  owner: string;
  name: string;
  /** Defining query, kept as AST so REFRESH can re-execute it. */
  queryAst: unknown;
  /** Original SQL text, surfaced by DBA_MVIEWS.QUERY. */
  queryText: string;
  buildMode: 'IMMEDIATE' | 'DEFERRED';
  refreshMethod: 'COMPLETE' | 'FORCE' | 'FAST';
  refreshMode: 'DEMAND' | 'COMMIT';
  /** Base tables the query reads — drives staleness on DML. */
  baseTables: { schema: string; table: string }[];
  lastRefresh: Date | null;
  staleness: 'FRESH' | 'STALE' | 'UNUSABLE';
}

/** One database link — PUBLIC links are owned by 'PUBLIC'. */
export interface DbLinkMeta {
  owner: string;
  name: string;
  /** CONNECT TO user, when the link carries fixed credentials. */
  username: string | null;
  /** CONNECT TO … IDENTIFIED BY password — used to open the remote
   *  session at query time; never exposed by the dictionary views. */
  password: string | null;
  /** The USING 'tns_alias' connect string. */
  host: string | null;
  created: Date;
}

/**
 * One directory object — a SQL name bound to a path on the database
 * server's host filesystem. Always owned by SYS in Oracle (the dictionary
 * reports OWNER = 'SYS' regardless of who issued CREATE DIRECTORY).
 */
export interface DirectoryMeta {
  /** Uppercased object name (the namespace is global, not schema-scoped). */
  name: string;
  /** Host filesystem path exactly as written in the AS clause. */
  path: string;
  created: Date;
}

export interface MviewLogMeta {
  owner: string;
  master: string;
  logTable: string;
  withRowid: boolean;
  withPrimaryKey: boolean;
  withSequence: boolean;
  pendingChanges: number;
  created: Date;
}

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
  success: string; // 'BY ACCESS' | 'BY SESSION' | 'NOT SET'
  failure: string; // 'BY ACCESS' | 'BY SESSION' | 'NOT SET'
}

/** Per-action audit mode for an object option ('-' = not audited). */
export interface ObjectAuditMode {
  success: 'A' | 'S' | '-';
  failure: 'A' | 'S' | '-';
}

/** A flattened object-level audit option row. */
export interface ObjectAuditOption {
  schema: string;
  object: string;
  action: string;
  success: 'A' | 'S' | '-';
  failure: 'A' | 'S' | '-';
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

// ── *_VIEWS columns ──────────────────────────────────────────────────
//
// Shared by DBA_VIEWS, ALL_VIEWS, and USER_VIEWS. The order and types
// match Oracle 19c so audit scripts that SELECT explicit columns work
// without modification.
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

/** One row of the recyclebin (Oracle's soft-drop staging area). */
export interface RecyclebinEntry {
  /** Owner schema. */
  owner: string;
  /** BIN$… auto-generated unique name. */
  objectName: string;
  /** Original object name before DROP. */
  originalName: string;
  /** Object kind — TABLE, INDEX, TRIGGER, …. */
  type: string;
  /** Tablespace containing the object's segments. */
  tsName: string;
  /** Approximate space in 512-byte blocks. */
  space: number;
  /** Drop timestamp. */
  droptime: Date;
  /**
   * Snapshot needed to restore the object via FLASHBACK …
   * TO BEFORE DROP. Opaque to consumers other than the executor.
   */
  payload?: unknown;
}

export interface SupplementalLogGroup {
  owner: string;
  logGroupName: string;
  tableName: string;
  always: boolean;
  /** Columns participating in the group, in declaration order. */
  columns: string[];
}

/** 22-hex-char id used in BIN$<id>==$0 object names — short and unique. */
function randomId(): string {
  return Array.from({ length: 22 }, () =>
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 62)]
  ).join('');
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

  private compilationErrors: Map<string, StoredUnitErrors> = new Map();

  setCompilationErrors(owner: string, name: string, type: string, errors: PlsqlCompilationError[]): void {
    const key = `${owner.toUpperCase()}.${name.toUpperCase()}`;
    if (errors.length === 0) {
      this.compilationErrors.delete(key);
      return;
    }
    this.compilationErrors.set(key, {
      owner: owner.toUpperCase(),
      name: name.toUpperCase(),
      type: type.toUpperCase(),
      errors,
    });
  }

  clearCompilationErrors(owner: string, name: string): void {
    this.compilationErrors.delete(`${owner.toUpperCase()}.${name.toUpperCase()}`);
  }

  getCompilationErrors(owner: string, name: string): StoredUnitErrors | undefined {
    return this.compilationErrors.get(`${owner.toUpperCase()}.${name.toUpperCase()}`);
  }

  getAllCompilationErrors(): StoredUnitErrors[] {
    return [...this.compilationErrors.values()];
  }

  /**
   * Object-level audit options keyed by `${schema}.${object}`, then by
   * action (SELECT, UPDATE, …). Each action records the success/failure
   * audit mode so DBA_OBJ_AUDIT_OPTS reports real `S/A/-` values.
   */
  private objAuditOpts: Map<string, Map<string, ObjectAuditMode>> = new Map();

  /** Custom profiles (name → resource overrides) */
  private profiles: Map<string, Map<string, string>> = new Map();

  /** Injected provider for stored PL/SQL units (avoids circular dependency) */
  private storedUnitsProvider: (() => StoredUnit[]) | null = null;
  /** Injected provider for user-package members (DBA_PROCEDURES). */
  private packageMembersProvider: (() => PackageMemberRow[]) | null = null;
  /** Injected SecurityEngine (set after construction to avoid circular dep) */
  private securityEngine: SecurityEngine | null = null;

  /** Set the provider for stored PL/SQL units */
  setStoredUnitsProvider(provider: () => StoredUnit[]): void {
    this.storedUnitsProvider = provider;
  }

  /** Set the provider for user-defined package members */
  setPackageMembersProvider(provider: () => PackageMemberRow[]): void {
    this.packageMembersProvider = provider;
  }

  // ── Public read accessors for self-registered DBA_ view files ────
  /** Stored PL/SQL units (DBA_SOURCE / DBA_PROCEDURES). */
  getStoredUnits(): StoredUnit[] { return this.storedUnitsProvider?.() ?? []; }
  /** User-defined package members (DBA_PROCEDURES). */
  getPackageMembers(): PackageMemberRow[] { return this.packageMembersProvider?.() ?? []; }
  /** Custom profile overrides (legacy DBA_PROFILES fallback). */
  getProfiles(): ReadonlyMap<string, Map<string, string>> { return this.profiles; }
  /** Object privilege grants (DBA_TAB_PRIVS). */
  getTablePrivilegeGrants(): ReadonlyArray<CatalogPrivilege> { return this.tabPrivileges; }
  /** Rows backing DBA_VIEWS / ALL_VIEWS / USER_VIEWS. */
  getCatalogViewRows(): (string | number | null)[][] { return this.collectViewRows(); }

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
      this.setPassword(u.username, password);
    }

    // Classic Oracle 19c roles + their canonical privileges
    // (one declarative table per role in security/classicRoles.ts).
    provisionClassicRoles(this);
    seedCatalogRoleObjectGrants(this);

    // SYS / SYSTEM hold the full system-privilege set with ADMIN OPTION.
    const sysPrivs = [
      'CREATE SESSION', 'CREATE TABLE', 'CREATE VIEW', 'CREATE SEQUENCE',
      'CREATE PROCEDURE', 'CREATE TRIGGER', 'CREATE INDEX', 'CREATE USER',
      'ALTER USER', 'DROP USER', 'CREATE ROLE', 'GRANT ANY PRIVILEGE',
      'GRANT ANY ROLE', 'SELECT ANY TABLE', 'INSERT ANY TABLE',
      'UPDATE ANY TABLE', 'DELETE ANY TABLE', 'CREATE ANY TABLE',
      'DROP ANY TABLE', 'ALTER ANY TABLE', 'CREATE TABLESPACE',
      'ALTER TABLESPACE', 'DROP TABLESPACE', 'ALTER SYSTEM',
      'ALTER DATABASE', 'UNLIMITED TABLESPACE', 'CREATE ANY DIRECTORY',
      'AUDIT SYSTEM', 'AUDIT ANY', 'CREATE PROFILE', 'ALTER PROFILE',
      'DROP PROFILE', 'SELECT ANY DICTIONARY',
    ];
    for (const priv of sysPrivs) {
      this.grantSystemPrivilege('SYS', priv, true);
      this.grantSystemPrivilege('SYSTEM', priv, true);
    }
    this.grantRole('SYS', 'DBA', true);
    this.grantRole('SYSTEM', 'DBA', true);
    this.grantRole('SYS', 'SELECT_CATALOG_ROLE', true);
    this.grantRole('SYS', 'AUDIT_ADMIN', true);
    this.grantRole('SYSTEM', 'AUDIT_ADMIN', true);

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

  private storedVerifiers: Map<string, OracleStoredVerifiers> = new Map();

  getStoredPassword(username: string): string | undefined {
    return this.passwords.get(username.toUpperCase());
  }

  setPassword(username: string, password: string): void {
    const upper = username.toUpperCase();
    this.passwords.set(upper, password);
    this.storedVerifiers.set(upper, deriveStoredVerifiers(upper, password));
  }

  getStoredVerifiers(username: string): OracleStoredVerifiers | undefined {
    const upper = username.toUpperCase();
    const stored = this.storedVerifiers.get(upper);
    if (stored) return stored;
    const password = this.passwords.get(upper);
    if (password === undefined) return undefined;
    const derived = deriveStoredVerifiers(upper, password);
    this.storedVerifiers.set(upper, derived);
    return derived;
  }

  /** Distinguished name registered for IDENTIFIED GLOBALLY users. */
  private externalNames: Map<string, string> = new Map();

  setExternalName(username: string, dn: string): void {
    this.externalNames.set(username.toUpperCase(), dn);
  }

  getExternalName(username: string): string | undefined {
    return this.externalNames.get(username.toUpperCase());
  }

  /** Plaintext role password (CREATE ROLE x IDENTIFIED BY pw); checked at SET ROLE. */
  private rolePasswords: Map<string, string> = new Map();

  setRolePassword(role: string, password: string): void {
    this.rolePasswords.set(role.toUpperCase(), password);
  }

  getRolePassword(role: string): string | undefined {
    return this.rolePasswords.get(role.toUpperCase());
  }

  // ── Column-level privileges (DBA_COL_PRIVS backing store) ─────────

  private colPrivileges: Array<{
    grantee: string;
    grantor: string;
    objectSchema: string;
    objectName: string;
    columnName: string;
    privilege: string;
    grantable: boolean;
  }> = [];

  grantColumnPrivilege(
    grantee: string, privilege: string, objectSchema: string, objectName: string,
    columnName: string, grantor: string = 'SYS', grantable: boolean = false,
  ): void {
    const upper = {
      grantee: grantee.toUpperCase(),
      privilege: privilege.toUpperCase(),
      objectSchema: objectSchema.toUpperCase(),
      objectName: objectName.toUpperCase(),
      columnName: columnName.toUpperCase(),
    };
    // Idempotent: identical grant collapses to one row (Oracle behavior).
    const exists = this.colPrivileges.some(p =>
      p.grantee === upper.grantee && p.privilege === upper.privilege &&
      p.objectSchema === upper.objectSchema && p.objectName === upper.objectName &&
      p.columnName === upper.columnName);
    if (exists) return;
    this.colPrivileges.push({ ...upper, grantor: grantor.toUpperCase(), grantable });
  }

  revokeColumnPrivilege(
    grantee: string, privilege: string, objectSchema: string, objectName: string,
    columnName: string,
  ): void {
    const g = grantee.toUpperCase(), p = privilege.toUpperCase();
    const os = objectSchema.toUpperCase(), on = objectName.toUpperCase(), c = columnName.toUpperCase();
    this.colPrivileges = this.colPrivileges.filter(row =>
      !(row.grantee === g && row.privilege === p
        && row.objectSchema === os && row.objectName === on && row.columnName === c));
  }

  getColumnPrivileges(): ReadonlyArray<{
    grantee: string; grantor: string; objectSchema: string; objectName: string;
    columnName: string; privilege: string; grantable: boolean;
  }> {
    return this.colPrivileges;
  }

  // ── Default role specification (per-user) ─────────────────────────

  private defaultRoleSpecs: Map<string, { mode: 'ALL' | 'NONE' | 'LIST' | 'EXCEPT'; roles: string[] }>
    = new Map();

  setDefaultRoleSpec(username: string, spec: { mode: 'ALL' | 'NONE' | 'LIST' | 'EXCEPT'; roles: string[] }): void {
    this.defaultRoleSpecs.set(username.toUpperCase(), {
      mode: spec.mode,
      roles: spec.roles.map(r => r.toUpperCase()),
    });
  }

  /** Whether `role` is enabled by default for `username`. ALL is the implicit fallback. */
  isDefaultRole(username: string, role: string): boolean {
    const spec = this.defaultRoleSpecs.get(username.toUpperCase());
    if (!spec) return true;                            // implicit ALL
    const r = role.toUpperCase();
    switch (spec.mode) {
      case 'ALL':    return true;
      case 'NONE':   return false;
      case 'LIST':   return spec.roles.includes(r);
      case 'EXCEPT': return !spec.roles.includes(r);
    }
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

  // ── Materialized views ────────────────────────────────────────────
  //
  // The MV container rows live in storage as a real table (that is what
  // makes SELECT work); this registry holds what makes it a materialized
  // view: the defining query, refresh metadata, and staleness. DML on a
  // base table flips dependent MVs to STALE (executor choke point).

  private materializedViews: Map<string, MaterializedViewMeta> = new Map();
  private static mvKey(owner: string, name: string): string {
    return `${owner.toUpperCase()}.${name.toUpperCase()}`;
  }

  registerMaterializedView(meta: MaterializedViewMeta): void {
    this.materializedViews.set(OracleCatalog.mvKey(meta.owner, meta.name), meta);
  }

  getMaterializedView(owner: string, name: string): MaterializedViewMeta | undefined {
    return this.materializedViews.get(OracleCatalog.mvKey(owner, name));
  }

  getMaterializedViews(): readonly MaterializedViewMeta[] {
    return [...this.materializedViews.values()];
  }

  dropMaterializedView(owner: string, name: string): boolean {
    return this.materializedViews.delete(OracleCatalog.mvKey(owner, name));
  }

  readonly tableHistory = new TableHistory();

  // ── Database links ────────────────────────────────────────────────

  private dbLinks: Map<string, DbLinkMeta> = new Map();

  registerDbLink(meta: DbLinkMeta): void {
    this.dbLinks.set(OracleCatalog.mvKey(meta.owner, meta.name), meta);
  }

  getDbLink(owner: string, name: string): DbLinkMeta | undefined {
    return this.dbLinks.get(OracleCatalog.mvKey(owner, name));
  }

  getDbLinks(): readonly DbLinkMeta[] {
    return [...this.dbLinks.values()];
  }

  dropDbLink(owner: string, name: string): boolean {
    return this.dbLinks.delete(OracleCatalog.mvKey(owner, name));
  }

  // ── Directory objects ─────────────────────────────────────────────
  // Seeded with DATA_PUMP_DIR, the directory every Oracle install ships
  // with (the former hardcoded DBA_DIRECTORIES row, now a real object).

  private directories: Map<string, DirectoryMeta> = new Map([
    ['DATA_PUMP_DIR', {
      name: 'DATA_PUMP_DIR',
      path: `${ORACLE_CONFIG.BASE}/admin/${ORACLE_CONFIG.SID}/dpdump/`,
      created: new Date(),
    }],
  ]);

  /** CREATE [OR REPLACE] DIRECTORY — replaces any existing binding. */
  registerDirectory(meta: DirectoryMeta): void {
    this.directories.set(meta.name.toUpperCase(), meta);
  }

  getDirectory(name: string): DirectoryMeta | undefined {
    return this.directories.get(name.toUpperCase());
  }

  getDirectories(): readonly DirectoryMeta[] {
    return [...this.directories.values()];
  }

  dropDirectory(name: string): boolean {
    return this.directories.delete(name.toUpperCase());
  }

  private mviewLogs: Map<string, MviewLogMeta> = new Map();

  registerMviewLog(meta: MviewLogMeta): void {
    this.mviewLogs.set(OracleCatalog.mvKey(meta.owner, meta.master), meta);
  }

  getMviewLog(owner: string, master: string): MviewLogMeta | undefined {
    return this.mviewLogs.get(OracleCatalog.mvKey(owner, master));
  }

  getMviewLogs(): readonly MviewLogMeta[] {
    return [...this.mviewLogs.values()];
  }

  dropMviewLog(owner: string, master: string): boolean {
    return this.mviewLogs.delete(OracleCatalog.mvKey(owner, master));
  }

  /** DML touched schema.table — every MV reading it is no longer fresh. */
  markMaterializedViewsStale(schema: string, table: string): void {
    const s = schema.toUpperCase(); const t = table.toUpperCase();
    const log = this.mviewLogs.get(OracleCatalog.mvKey(s, t));
    if (log) log.pendingChanges++;
    for (const mv of this.materializedViews.values()) {
      if (mv.baseTables.some(b => b.schema === s && b.table === t)) {
        mv.staleness = 'STALE';
      }
    }
  }

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

  /** Add/replace an object-level audit option (AUDIT action ON obj). */
  setObjectAuditOption(
    schema: string, object: string, action: string, mode: ObjectAuditMode,
  ): void {
    const key = `${schema.toUpperCase()}.${object.toUpperCase()}`;
    const actions = this.objAuditOpts.get(key) ?? new Map<string, ObjectAuditMode>();
    actions.set(action.toUpperCase(), mode);
    this.objAuditOpts.set(key, actions);
  }

  /** Remove an object-level audit option; drops the object once empty. */
  clearObjectAuditOption(schema: string, object: string, action: string): void {
    const key = `${schema.toUpperCase()}.${object.toUpperCase()}`;
    const actions = this.objAuditOpts.get(key);
    if (!actions) return;
    actions.delete(action.toUpperCase());
    if (actions.size === 0) this.objAuditOpts.delete(key);
  }

  /** Flattened, read-only snapshot of every object audit option. */
  getObjectAuditOptions(): ObjectAuditOption[] {
    const out: ObjectAuditOption[] = [];
    for (const [key, actions] of this.objAuditOpts) {
      const dot = key.indexOf('.');
      const schema = key.slice(0, dot);
      const object = key.slice(dot + 1);
      for (const [action, mode] of actions) {
        out.push({ schema, object, action, success: mode.success, failure: mode.failure });
      }
    }
    return out;
  }

  /**
   * Resolve the Oracle object type (TABLE / VIEW / SEQUENCE / …) for an
   * owner.object pair from real storage, so DBA_OBJ_AUDIT_OPTS never
   * hardcodes a type. Falls back to a name-only match, then 'TABLE'
   * (Oracle keeps the audit option even after the object is dropped).
   */
  resolveObjectType(schema: string, object: string): string {
    const owner = schema.toUpperCase();
    const name = object.toUpperCase();
    const objs = this.enumerateObjects();
    const exact = objs.find(o => o.owner.toUpperCase() === owner && o.name.toUpperCase() === name);
    if (exact) return exact.type;
    const byName = objs.find(o => o.name.toUpperCase() === name);
    return byName ? byName.type : 'TABLE';
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

  // ── Recyclebin ────────────────────────────────────────────────────

  /**
   * Recyclebin entries — one row per object soft-dropped via
   * `DROP TABLE` (no PURGE). FLASHBACK TABLE … TO BEFORE DROP and
   * PURGE RECYCLEBIN both consult / mutate this map.
   */
  private recyclebin: RecyclebinEntry[] = [];

  recyclebinAdd(entry: Omit<RecyclebinEntry, 'objectName' | 'droptime'> & { droptime?: Date }): RecyclebinEntry {
    const objectName = `BIN$${randomId()}==$0`;
    const full: RecyclebinEntry = {
      ...entry,
      objectName,
      droptime: entry.droptime ?? new Date(),
    };
    this.recyclebin.push(full);
    return full;
  }

  /** Find the most recent recyclebin entry matching the original name. */
  recyclebinFindLatest(owner: string, originalName: string): RecyclebinEntry | undefined {
    for (let i = this.recyclebin.length - 1; i >= 0; i--) {
      const e = this.recyclebin[i];
      if (e.owner === owner.toUpperCase() && e.originalName === originalName.toUpperCase()) {
        return e;
      }
    }
    return undefined;
  }

  /** Remove a recyclebin entry by object name (returns true if removed). */
  recyclebinRemove(objectName: string): boolean {
    const idx = this.recyclebin.findIndex(e => e.objectName === objectName);
    if (idx < 0) return false;
    this.recyclebin.splice(idx, 1);
    return true;
  }

  /** Empty the recyclebin (PURGE RECYCLEBIN / DBA_RECYCLEBIN). */
  recyclebinPurgeAll(owner?: string): number {
    if (owner) {
      const upper = owner.toUpperCase();
      const before = this.recyclebin.length;
      this.recyclebin = this.recyclebin.filter(e => e.owner !== upper);
      return before - this.recyclebin.length;
    }
    const n = this.recyclebin.length;
    this.recyclebin = [];
    return n;
  }

  getRecyclebin(): readonly RecyclebinEntry[] { return this.recyclebin; }

  // ── Supplemental log groups ──────────────────────────────────────

  /**
   * Supplemental log groups defined via `ALTER TABLE … ADD SUPPLEMENTAL
   * LOG GROUP name (col [,col]) [ALWAYS]`. Empty until DBAs add any.
   */
  private supLogGroups: SupplementalLogGroup[] = [];

  addSupplementalLogGroup(g: SupplementalLogGroup): void {
    this.supLogGroups.push(g);
  }

  dropSupplementalLogGroup(owner: string, name: string): boolean {
    const idx = this.supLogGroups.findIndex(g =>
      g.owner === owner.toUpperCase() && g.logGroupName === name.toUpperCase());
    if (idx < 0) return false;
    this.supLogGroups.splice(idx, 1);
    return true;
  }

  getSupplementalLogGroups(): readonly SupplementalLogGroup[] { return this.supLogGroups; }

  // ── Proxy authentication ─────────────────────────────────────────
  //
  // `ALTER USER <client> GRANT CONNECT THROUGH <proxy> [WITH ROLE r]`
  // adds a row here; the matching `REVOKE` variant removes it. The
  // simulator does not actually arbitrate connection routing — the
  // mapping exists so PROXY_USERS reports what real Oracle would.

  private proxyUsers: { client: string; proxy: string; role: string | null }[] = [];

  grantProxy(client: string, proxy: string, role?: string): void {
    const c = client.toUpperCase();
    const p = proxy.toUpperCase();
    const r = role ? role.toUpperCase() : null;
    const existing = this.proxyUsers.find(x => x.client === c && x.proxy === p);
    if (existing) { existing.role = r; return; }
    this.proxyUsers.push({ client: c, proxy: p, role: r });
  }

  revokeProxy(client: string, proxy: string): boolean {
    const c = client.toUpperCase();
    const p = proxy.toUpperCase();
    const idx = this.proxyUsers.findIndex(x => x.client === c && x.proxy === p);
    if (idx < 0) return false;
    this.proxyUsers.splice(idx, 1);
    return true;
  }

  getProxyUsers(): readonly { client: string; proxy: string; role: string | null }[] {
    return this.proxyUsers;
  }

  // ── COMMENT ON … IS …  ─────────────────────────────────────────
  //
  // Table / view / column comments persist here so DBA_TAB_COMMENTS
  // and DBA_COL_COMMENTS surface what the DBA wrote.

  private tableComments = new Map<string, string>();
  private columnComments = new Map<string, string>();

  private static tabCommentKey(schema: string, table: string): string {
    return `${schema.toUpperCase()}.${table.toUpperCase()}`;
  }
  private static colCommentKey(schema: string, table: string, column: string): string {
    return `${schema.toUpperCase()}.${table.toUpperCase()}.${column.toUpperCase()}`;
  }

  setTableComment(schema: string, table: string, text: string): void {
    this.tableComments.set(OracleCatalog.tabCommentKey(schema, table), text);
  }
  setColumnComment(schema: string, table: string, column: string, text: string): void {
    this.columnComments.set(OracleCatalog.colCommentKey(schema, table, column), text);
  }
  getTableComment(schema: string, table: string): string | null {
    return this.tableComments.get(OracleCatalog.tabCommentKey(schema, table)) ?? null;
  }
  getColumnComment(schema: string, table: string, column: string): string | null {
    return this.columnComments.get(OracleCatalog.colCommentKey(schema, table, column)) ?? null;
  }
  getAllTableComments(): ReadonlyMap<string, string> { return this.tableComments; }
  getAllColumnComments(): ReadonlyMap<string, string> { return this.columnComments; }

  // ── Unified audit policies ───────────────────────────────────────

  private unifiedAuditPolicies = new Map<string, {
    name: string;
    actions: string[];
    objectSchema?: string;
    objectName?: string;
    roles: string[];
    /** Enabled users (BY clause). `null` ⇒ enabled for ALL USERS. */
    enabledFor: string[] | null;
    /** Users excluded from a BY ALL enablement. */
    exceptUsers: string[];
    enabled: boolean;
  }>();

  createUnifiedAuditPolicy(p: { name: string; actions: string[]; objectSchema?: string; objectName?: string; roles?: string[] }): void {
    const key = p.name.toUpperCase();
    if (this.unifiedAuditPolicies.has(key)) {
      throw new Error(`ORA-46361: audit policy ${key} already exists`);
    }
    this.unifiedAuditPolicies.set(key, {
      name: key,
      actions: p.actions.map(a => a.toUpperCase()),
      objectSchema: p.objectSchema?.toUpperCase(),
      objectName: p.objectName?.toUpperCase(),
      roles: (p.roles ?? []).map(r => r.toUpperCase()),
      enabledFor: [],
      exceptUsers: [],
      enabled: false,
    });
  }

  dropUnifiedAuditPolicy(name: string): boolean {
    return this.unifiedAuditPolicies.delete(name.toUpperCase());
  }

  enableUnifiedAuditPolicy(name: string, byUsers?: string[], exceptUsers?: string[]): void {
    const key = name.toUpperCase();
    const p = this.unifiedAuditPolicies.get(key);
    if (!p) throw new Error(`ORA-46365: audit policy ${key} does not exist`);
    p.enabled = true;
    if (byUsers && byUsers.length > 0) {
      const set = new Set(p.enabledFor ?? []);
      for (const u of byUsers) set.add(u.toUpperCase());
      p.enabledFor = [...set];
    } else if (exceptUsers && exceptUsers.length > 0) {
      // BY EXCEPT — enable for all users except listed.
      p.enabledFor = null;
      const set = new Set(p.exceptUsers);
      for (const u of exceptUsers) set.add(u.toUpperCase());
      p.exceptUsers = [...set];
    } else {
      // Bare AUDIT POLICY name — enable for ALL USERS.
      p.enabledFor = null;
    }
  }

  disableUnifiedAuditPolicy(name: string, byUsers?: string[]): void {
    const key = name.toUpperCase();
    const p = this.unifiedAuditPolicies.get(key);
    if (!p) throw new Error(`ORA-46365: audit policy ${key} does not exist`);
    if (!byUsers || byUsers.length === 0) {
      p.enabled = false;
      p.enabledFor = [];
      p.exceptUsers = [];
      return;
    }
    if (p.enabledFor !== null) {
      const set = new Set(p.enabledFor);
      for (const u of byUsers) set.delete(u.toUpperCase());
      p.enabledFor = [...set];
    } else {
      // Removing specific users from a BY ALL enablement → add them to except.
      const set = new Set(p.exceptUsers);
      for (const u of byUsers) set.add(u.toUpperCase());
      p.exceptUsers = [...set];
    }
  }

  // ── Transparent Data Encryption (TDE) ────────────────────────────
  //
  // The simulator does not encrypt anything for real, but it tracks the
  // wallet / master-key / per-column metadata that DBAs would manage
  // through `ADMINISTER KEY MANAGEMENT` and `ALTER TABLE … ENCRYPT`.
  // Views (V$ENCRYPTION_KEYS, V$ENCRYPTION_WALLET,
  // DBA_ENCRYPTED_COLUMNS) read live state from here — no hard-coded
  // rows. Empty until an admin configures TDE, exactly like a real DB.

  private tdeWallet: {
    location: string;
    status: 'OPEN' | 'CLOSED' | 'OPEN_NO_MASTER_KEY';
    walletType: 'PASSWORD' | 'AUTOLOGIN' | 'LOCAL_AUTOLOGIN';
    fullyBackedUp: boolean;
  } | null = null;

  private tdeKeys: {
    keyId: string;
    tag: string;
    creator: string;
    creationTime: Date;
    activationTime: Date;
    active: boolean;
  }[] = [];

  private encryptedColumns: {
    owner: string;
    tableName: string;
    columnName: string;
    encryptionAlg: string;
    salt: boolean;
    integrityAlg: string;
  }[] = [];

  configureTdeWallet(loc: string, type: 'PASSWORD' | 'AUTOLOGIN' | 'LOCAL_AUTOLOGIN' = 'PASSWORD'): void {
    this.tdeWallet = { location: loc, status: 'OPEN_NO_MASTER_KEY', walletType: type, fullyBackedUp: false };
  }

  openTdeWallet(): void {
    if (!this.tdeWallet) throw new Error('ORA-28365: wallet is not open');
    this.tdeWallet.status = this.tdeKeys.length > 0 ? 'OPEN' : 'OPEN_NO_MASTER_KEY';
  }

  closeTdeWallet(): void {
    if (this.tdeWallet) this.tdeWallet.status = 'CLOSED';
  }

  addTdeMasterKey(tag: string, creator: string): { keyId: string } {
    if (!this.tdeWallet || this.tdeWallet.status === 'CLOSED') {
      throw new Error('ORA-28365: wallet is not open');
    }
    const now = new Date();
    // Synthesise a 78-char base64-like key id from time + sequence — real
    // Oracle uses a UUID-style identifier; reproducibility is fine here.
    const seq = (this.tdeKeys.length + 1).toString().padStart(4, '0');
    const keyId = `AbCdEf${now.getTime().toString(36).padStart(12, '0').toUpperCase()}${seq}==`;
    for (const k of this.tdeKeys) k.active = false;
    this.tdeKeys.push({ keyId, tag, creator: creator.toUpperCase(), creationTime: now, activationTime: now, active: true });
    this.tdeWallet.status = 'OPEN';
    return { keyId };
  }

  setColumnEncryption(owner: string, tableName: string, columnName: string, alg = 'AES192', salt = true, integrity = 'SHA-1'): void {
    const o = owner.toUpperCase(), t = tableName.toUpperCase(), c = columnName.toUpperCase();
    const existing = this.encryptedColumns.find(e => e.owner === o && e.tableName === t && e.columnName === c);
    if (existing) { existing.encryptionAlg = alg; existing.salt = salt; existing.integrityAlg = integrity; return; }
    this.encryptedColumns.push({ owner: o, tableName: t, columnName: c, encryptionAlg: alg, salt, integrityAlg: integrity });
  }

  clearColumnEncryption(owner: string, tableName: string, columnName: string): boolean {
    const o = owner.toUpperCase(), t = tableName.toUpperCase(), c = columnName.toUpperCase();
    const idx = this.encryptedColumns.findIndex(e => e.owner === o && e.tableName === t && e.columnName === c);
    if (idx < 0) return false;
    this.encryptedColumns.splice(idx, 1);
    return true;
  }

  getTdeWallet(): { location: string; status: string; walletType: string; fullyBackedUp: boolean } | null {
    return this.tdeWallet;
  }
  getTdeMasterKeys(): readonly { keyId: string; tag: string; creator: string; creationTime: Date; activationTime: Date; active: boolean }[] {
    return this.tdeKeys;
  }
  getEncryptedColumns(): readonly { owner: string; tableName: string; columnName: string; encryptionAlg: string; salt: boolean; integrityAlg: string }[] {
    return this.encryptedColumns;
  }

  // ── Database Vault ───────────────────────────────────────────────
  //
  // Identical pattern to TDE: the catalog holds the realms / roles /
  // command rules / factors that an admin would register via
  // DBMS_MACADM. Views read live state. Empty by default — DV is not
  // configured on a fresh install.

  private dvRealms: { name: string; description: string; auditOptions: number; enabled: boolean }[] = [];
  private dvRoles: { name: string; enabled: boolean; ruleSetName: string }[] = [];
  private dvRealmAuth: { realmName: string; grantee: string; authRuleSetName: string; authOptions: string }[] = [];
  private dvCommandRules: { command: string; ruleSetName: string; objectOwner: string; objectName: string; enabled: boolean }[] = [];
  private dvFactors: { name: string; description: string; factorType: string; validateExpr: string; identifyBy: string; labeledBy: string; evalOptions: string; auditOptions: number; failOptions: number }[] = [];

  createDvRealm(name: string, description: string, auditOptions = 1): void {
    this.dvRealms.push({ name: name.toUpperCase(), description, auditOptions, enabled: true });
  }
  createDvRole(name: string, ruleSetName: string): void {
    this.dvRoles.push({ name: name.toUpperCase(), enabled: true, ruleSetName });
  }
  addDvRealmAuth(realmName: string, grantee: string, authRuleSetName = '', authOptions = 'PARTICIPANT'): void {
    this.dvRealmAuth.push({ realmName: realmName.toUpperCase(), grantee: grantee.toUpperCase(), authRuleSetName, authOptions });
  }
  createDvCommandRule(command: string, ruleSetName: string, objectOwner: string, objectName: string): void {
    this.dvCommandRules.push({ command: command.toUpperCase(), ruleSetName, objectOwner: objectOwner.toUpperCase(), objectName: objectName.toUpperCase(), enabled: true });
  }
  createDvFactor(f: { name: string; description: string; factorType: string; validateExpr?: string; identifyBy?: string; labeledBy?: string; evalOptions?: string; auditOptions?: number; failOptions?: number }): void {
    this.dvFactors.push({
      name: f.name.toUpperCase(), description: f.description, factorType: f.factorType,
      validateExpr: f.validateExpr ?? '', identifyBy: f.identifyBy ?? 'BY_CONSTANT',
      labeledBy: f.labeledBy ?? 'BY_SELF', evalOptions: f.evalOptions ?? 'BY_SESSION',
      auditOptions: f.auditOptions ?? 1, failOptions: f.failOptions ?? 1,
    });
  }
  getDvRealms(): readonly { name: string; description: string; auditOptions: number; enabled: boolean }[] { return this.dvRealms; }
  getDvRoles(): readonly { name: string; enabled: boolean; ruleSetName: string }[] { return this.dvRoles; }
  getDvRealmAuth(): readonly { realmName: string; grantee: string; authRuleSetName: string; authOptions: string }[] { return this.dvRealmAuth; }
  getDvCommandRules(): readonly { command: string; ruleSetName: string; objectOwner: string; objectName: string; enabled: boolean }[] { return this.dvCommandRules; }
  getDvFactors(): readonly { name: string; description: string; factorType: string; validateExpr: string; identifyBy: string; labeledBy: string; evalOptions: string; auditOptions: number; failOptions: number }[] { return this.dvFactors; }

  // ── Row-Level Security (Virtual Private Database) ────────────────
  //
  // DBMS_RLS.ADD_POLICY / ADD_GROUPED_POLICY register an RLS policy
  // that the executor would apply as a predicate transform on the
  // target object. The catalog records the policy; views surface it.

  private rlsPolicies: {
    objectOwner: string;
    objectName: string;
    policyName: string;
    policyGroup: string;          // 'SYS_DEFAULT' for ungrouped policies.
    pfOwner: string;
    pfPackage: string | null;
    pfFunction: string;
    statementTypes: { sel: boolean; ins: boolean; upd: boolean; del: boolean; idx: boolean };
    enabled: boolean;
    /** Columns that activate the policy (DBMS_RLS sec_relevant_cols). */
    secRelevantCols: string[];
    policyType: 'STATIC' | 'SHARED_STATIC' | 'CONTEXT_SENSITIVE' | 'SHARED_CONTEXT_SENSITIVE' | 'DYNAMIC';
  }[] = [];

  /** Distinct (object, group) tuples shown by DBA_POLICY_GROUPS. */
  private rlsPolicyGroups: { objectOwner: string; objectName: string; policyGroup: string }[] = [];

  /** Application-context drivers shown by DBA_POLICY_CONTEXTS. */
  private rlsPolicyContexts: { objectOwner: string; objectName: string; namespace: string; attribute: string }[] = [];

  addRlsPolicy(p: {
    objectSchema: string; objectName: string; policyName: string;
    functionSchema: string; policyFunction: string;
    statementTypes?: string; policyType?: string;
    policyGroup?: string;
    secRelevantCols?: string;
  }): void {
    const parts = p.policyFunction.split('.');
    const pkg = parts.length === 2 ? parts[0].toUpperCase() : null;
    const fn = (parts.length === 2 ? parts[1] : parts[0]).toUpperCase();
    const types = (p.statementTypes ?? 'SELECT,INSERT,UPDATE,DELETE').toUpperCase();
    this.rlsPolicies.push({
      objectOwner: p.objectSchema.toUpperCase(),
      objectName: p.objectName.toUpperCase(),
      policyName: p.policyName.toUpperCase(),
      policyGroup: (p.policyGroup ?? 'SYS_DEFAULT').toUpperCase(),
      pfOwner: p.functionSchema.toUpperCase(),
      pfPackage: pkg,
      pfFunction: fn,
      statementTypes: {
        sel: types.includes('SELECT'),
        ins: types.includes('INSERT'),
        upd: types.includes('UPDATE'),
        del: types.includes('DELETE'),
        idx: types.includes('INDEX'),
      },
      enabled: true,
      secRelevantCols: (p.secRelevantCols ?? '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean),
      policyType: (p.policyType ?? 'DYNAMIC') as 'DYNAMIC',
    });
    if (p.policyGroup && p.policyGroup.toUpperCase() !== 'SYS_DEFAULT') {
      const key = `${p.objectSchema.toUpperCase()}.${p.objectName.toUpperCase()}.${p.policyGroup.toUpperCase()}`;
      if (!this.rlsPolicyGroups.some(g => `${g.objectOwner}.${g.objectName}.${g.policyGroup}` === key)) {
        this.rlsPolicyGroups.push({
          objectOwner: p.objectSchema.toUpperCase(),
          objectName: p.objectName.toUpperCase(),
          policyGroup: p.policyGroup.toUpperCase(),
        });
      }
    }
  }

  enableRlsPolicy(objectSchema: string, objectName: string, policyName: string, enable: boolean): boolean {
    const p = this.rlsPolicies.find(x =>
      x.objectOwner === objectSchema.toUpperCase()
      && x.objectName === objectName.toUpperCase()
      && x.policyName === policyName.toUpperCase());
    if (!p) return false;
    p.enabled = enable;
    return true;
  }

  dropRlsPolicy(objectSchema: string, objectName: string, policyName: string): boolean {
    const idx = this.rlsPolicies.findIndex(x =>
      x.objectOwner === objectSchema.toUpperCase()
      && x.objectName === objectName.toUpperCase()
      && x.policyName === policyName.toUpperCase());
    if (idx < 0) return false;
    this.rlsPolicies.splice(idx, 1);
    return true;
  }

  getRlsPolicies(): readonly typeof this.rlsPolicies[number][] { return this.rlsPolicies; }
  getRlsPolicyGroups(): readonly { objectOwner: string; objectName: string; policyGroup: string }[] { return this.rlsPolicyGroups; }
  getRlsPolicyContexts(): readonly { objectOwner: string; objectName: string; namespace: string; attribute: string }[] { return this.rlsPolicyContexts; }

  getUnifiedAuditPolicies(): readonly {
    name: string; actions: string[]; objectSchema?: string; objectName?: string;
    roles: string[]; enabledFor: string[] | null; exceptUsers: string[]; enabled: boolean;
  }[] {
    return [...this.unifiedAuditPolicies.values()];
  }

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
    // Every V$ view is self-registered under views/*.ts.
    const fromRegistry = queryView(name, {
      instance: this.instance,
      storage: this.storage,
      runtime: this.instance.getRuntimeState(),
      catalog: this,
      currentUser: _currentUser,
    });
    if (fromRegistry) return fromRegistry;
    // Unknown V$/GV$ view → let the executor raise ORA-00942 (table or
    // view does not exist), matching real Oracle's behavior.
    return null;
  }

  // ── DBA_ views ───────────────────────────────────────────────────

  private queryDBA(viewName: string, _currentUser: string): ResultSet | null {
    // Every DBA_ dictionary view is self-registered under views/*.ts.
    const fromRegistry = queryView(viewName, {
      instance: this.instance,
      storage: this.storage,
      runtime: this.instance.getRuntimeState(),
      catalog: this,
      currentUser: _currentUser,
    });
    return fromRegistry ?? null; // Unknown view — fall through to table lookup
  }


  enumerateObjects(): EnumeratedObject[] {
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


  // ── ALL_ views (user-accessible objects) ─────────────────────────

  private queryALL(viewName: string, currentUser: string): ResultSet | null {
    // Registry overrides — when an ALL_* view has its own dedicated
    // definition (e.g. ALL_USERS has a smaller column shape than the
    // generic ALL_→DBA_ derivation would produce), honour it before
    // falling through to the generic mapping.
    const fromRegistry = queryView(viewName, {
      instance: this.instance, storage: this.storage,
      runtime: this.instance.getRuntimeState(), catalog: this,
      currentUser,
    });
    if (fromRegistry) return fromRegistry;

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
      const dba = this.queryDBA('DBA_OBJECTS', currentUser)!;
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

    // Registry overrides — when a USER_* view has its own definition
    // (e.g. USER_TAB_PRIVS_MADE has a smaller shape than the generic
    // USER_→DBA_ derivation produces), honour it first.
    const fromRegistry = queryView(viewName, {
      instance: this.instance, storage: this.storage,
      runtime: this.instance.getRuntimeState(), catalog: this,
      currentUser,
    });
    if (fromRegistry) return fromRegistry;

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
      const dba = this.queryDBA('DBA_OBJECTS', currentUser)!;
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
    // SYS.X$ base tables are self-registered under views/sys_*.ts.
    const fromRegistry = queryView(`SYS.${tableName}`, {
      instance: this.instance,
      storage: this.storage,
      runtime: this.instance.getRuntimeState(),
      catalog: this,
      currentUser: "SYS",
    });
    return fromRegistry ?? null;
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

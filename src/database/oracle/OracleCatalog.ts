/**
 * OracleCatalog — Oracle data dictionary implementation.
 *
 * Provides V$ dynamic performance views and DBA_/ALL_/USER_ dictionary views.
 * Queries against these views return simulated metadata from the storage layer.
 */

import { BaseCatalog, type CatalogUser, type CatalogPrivilege } from '../engine/catalog/BaseCatalog';
import { type ResultSet, queryResult, emptyResult } from '../engine/executor/ResultSet';
import { oracleVarchar2, oracleNumber, oracleDate } from '../engine/catalog/DataType';
import type { OracleStorage } from './OracleStorage';
import type { OracleInstance } from './OracleInstance';
import { ORACLE_CONFIG } from '../../terminal/commands/OracleConfig';
import { queryView, listCatalogViewEntries, type CatalogViewEntry } from './views/registry';
import { VIEW_COLUMNS } from './views/_viewColumns';
import { BUILTIN_VIEWS } from './views/builtinCatalog';
import type { SecurityEngine } from './security/SecurityEngine';
import { provisionClassicRoles, seedCatalogRoleObjectGrants } from './security/classicRoles';
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
  /** Injected SecurityEngine (set after construction to avoid circular dep) */
  private securityEngine: SecurityEngine | null = null;

  /** Set the provider for stored PL/SQL units */
  setStoredUnitsProvider(provider: () => StoredUnit[]): void {
    this.storedUnitsProvider = provider;
  }

  // ── Public read accessors for self-registered DBA_ view files ────
  /** Stored PL/SQL units (DBA_SOURCE / DBA_PROCEDURES). */
  getStoredUnits(): StoredUnit[] { return this.storedUnitsProvider?.() ?? []; }
  /** Custom profile overrides (legacy DBA_PROFILES fallback). */
  getProfiles(): ReadonlyMap<string, Map<string, string>> { return this.profiles; }
  /** Role grants (DBA_ROLE_PRIVS). */
  getRoleGrants(): ReadonlyArray<{ grantee: string; role: string; adminOption: boolean }> {
    return this.roleGrants;
  }
  /** System privilege grants (DBA_SYS_PRIVS). */
  getSysPrivilegeGrants(): ReadonlyArray<CatalogPrivilege> { return this.sysPrivileges; }
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
      this.passwords.set(u.username, password);
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
    return emptyResult(`View ${name} not implemented`);
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

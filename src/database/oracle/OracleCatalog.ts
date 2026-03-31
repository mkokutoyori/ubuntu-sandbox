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

/** Stored PL/SQL unit shape (avoids circular import with OracleDatabase) */
interface StoredUnit {
  schema: string; name: string; type: string;
  parameters: Array<{ name: string; mode: string; dataType: string }>;
  returnType?: string; body: string; sourceLines: string[];
  created: Date; status: string;
}

/** Audit trail entry shape */
interface AuditEntry {
  sessionId: number;
  osUsername: string;
  username: string;
  userhost: string;
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
interface StmtAuditOption {
  auditOption: string;
  userName: string | null; // null = all users
  success: string; // BY ACCESS or BY SESSION
  failure: string; // BY ACCESS or BY SESSION
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

  /** Custom profiles (name → resource overrides) */
  private profiles: Map<string, Map<string, string>> = new Map();

  /** Injected provider for stored PL/SQL units (avoids circular dependency) */
  private storedUnitsProvider: (() => StoredUnit[]) | null = null;

  /** Set the provider for stored PL/SQL units */
  setStoredUnitsProvider(provider: () => StoredUnit[]): void {
    this.storedUnitsProvider = provider;
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

  setPassword(username: string, password: string): void {
    this.passwords.set(username.toUpperCase(), password);
  }

  /** Allocate a unique user ID for new users */
  allocateUserId(): number {
    return this.nextUserId++;
  }

  // ── Audit trail recording ──────────────────────────────────────

  /** Record an audit trail entry */
  recordAudit(entry: Omit<AuditEntry, 'sessionId' | 'osUsername' | 'userhost' | 'timestamp'>): void {
    this.auditTrail.push({
      sessionId: this.sessionId,
      osUsername: 'oracle',
      userhost: 'localhost',
      timestamp: new Date(),
      ...entry,
    });
  }

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

  // ── Profile management ──────────────────────────────────────────

  /** Create a custom profile with resource limit overrides */
  createProfile(name: string, limits: Map<string, string>): void {
    this.profiles.set(name.toUpperCase(), limits);
  }

  /** Alter an existing profile's limits */
  alterProfile(name: string, limits: Map<string, string>): void {
    const upper = name.toUpperCase();
    const existing = this.profiles.get(upper);
    if (!existing) throw new Error(`Profile ${upper} does not exist`);
    for (const [k, v] of limits) existing.set(k, v);
  }

  /** Drop a custom profile */
  dropProfile(name: string): void {
    this.profiles.delete(name.toUpperCase());
  }

  /** Check if a profile exists */
  profileExists(name: string): boolean {
    return name.toUpperCase() === 'DEFAULT' || this.profiles.has(name.toUpperCase());
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
      default: return emptyResult(`View ${name} not implemented`);
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
    const now = new Date().toISOString();
    return queryResult(
      [
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
      ],
      [
        [1, 1, 'SYS', 'ACTIVE', 'oracle', 'localhost', 'oracle@localhost (PMON)', 'BACKGROUND', now, 'SYS', 0, null],
        [2, 1, 'SYS', 'ACTIVE', 'oracle', 'localhost', 'oracle@localhost (SMON)', 'BACKGROUND', now, 'SYS', 0, null],
        [3, 1, 'SYS', 'ACTIVE', 'oracle', 'localhost', 'oracle@localhost (DBW0)', 'BACKGROUND', now, 'SYS', 0, null],
        [4, 1, 'SYS', 'ACTIVE', 'oracle', 'localhost', 'oracle@localhost (LGWR)', 'BACKGROUND', now, 'SYS', 0, null],
        [10, 100, currentUser.toUpperCase(), 'ACTIVE', 'oracle', 'localhost', 'sqlplus@localhost', 'USER', now, currentUser.toUpperCase(), 3, null],
      ]
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
      case 'DBA_PROFILES': return this.dbaProfiles();
      case 'DBA_TAB_STATISTICS': return this.dbaTabStatistics();
      case 'DBA_DIRECTORIES': return this.dbaDirectories();
      case 'DBA_DB_LINKS': return this.dbaDbLinks();
      case 'DBA_JOBS': return this.dbaJobs();
      case 'DBA_SCHEDULER_JOBS': return this.dbaSchedulerJobs();
      case 'DBA_SYNONYMS': return this.dbaSynonyms();
      default: return null;  // Unknown view — fall through to table lookup
    }
  }

  private dbaUsers(): ResultSet {
    const users = this.getAllUsers();
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
      users.map(u => [
        u.username,
        u.userId,
        u.accountStatus,
        u.lockDate ? u.lockDate.toISOString() : null,
        u.expiryDate ? u.expiryDate.toISOString() : null,
        u.defaultTablespace,
        u.temporaryTablespace,
        u.created.toISOString(),
        u.profile,
        u.authenticationType,
      ])
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
    const tables = this.storage.getAllTables();
    const rows: (string | number | null)[][] = tables.map(t => [t.schema, t.name, 'TABLE', 'VALID']);
    // Add indexes
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        rows.push([schema, idx.name, 'INDEX', 'VALID']);
      }
    }
    // Add stored PL/SQL units
    const units = this.storedUnitsProvider?.() ?? [];
    for (const u of units) {
      rows.push([u.schema, u.name, u.type, u.status]);
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'OBJECT_NAME', dataType: oracleVarchar2(128) },
        { name: 'OBJECT_TYPE', dataType: oracleVarchar2(23) },
        { name: 'STATUS', dataType: oracleVarchar2(7) },
      ],
      rows
    );
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

  private dbaViews(): ResultSet {
    const views = this.storage.getAllViews?.() ?? [];
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'VIEW_NAME', dataType: oracleVarchar2(30) },
        { name: 'TEXT_LENGTH', dataType: oracleNumber(10) },
        { name: 'TEXT', dataType: oracleVarchar2(4000) },
      ],
      views.map((v: any) => [v.schema, v.name, v.text?.length ?? 0, v.text ?? ''])
    );
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
    const rows: (string | number | null)[][] = [];

    // DEFAULT profile
    for (const [resName, resType, defaultLimit] of OracleCatalog.PROFILE_RESOURCES) {
      rows.push(['DEFAULT', resName, resType, defaultLimit]);
    }

    // Custom profiles — override specified limits, inherit DEFAULT for the rest
    for (const [profileName, overrides] of this.profiles) {
      for (const [resName, resType] of OracleCatalog.PROFILE_RESOURCES) {
        const limit = overrides.get(resName) ?? 'DEFAULT';
        rows.push([profileName, resName, resType, limit]);
      }
    }

    return queryResult(
      [
        { name: 'PROFILE', dataType: oracleVarchar2(128) },
        { name: 'RESOURCE_NAME', dataType: oracleVarchar2(32) },
        { name: 'RESOURCE_TYPE', dataType: oracleVarchar2(8) },
        { name: 'LIMIT', dataType: oracleVarchar2(128) },
      ],
      rows
    );
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
    // ALL_ views show objects accessible to the current user
    // For simplicity, show same as DBA_ for now (will filter later)
    const dbaName = viewName.replace('ALL_', 'DBA_');
    return this.queryDBA(dbaName, currentUser);
  }

  // ── USER_ views (current user's objects) ─────────────────────────

  private queryUSER(viewName: string, currentUser: string): ResultSet | null {
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
    const views = [
      // V$ dynamic performance views
      ['V$VERSION', 'Oracle version information'],
      ['V$INSTANCE', 'Instance information'],
      ['V$DATABASE', 'Database information'],
      ['V$SESSION', 'Active sessions'],
      ['V$PARAMETER', 'System parameters'],
      ['V$SPPARAMETER', 'Server parameter file parameters'],
      ['V$SYSTEM_PARAMETER', 'System parameters (alias of V$PARAMETER)'],
      ['V$SGA', 'SGA memory areas'],
      ['V$SGASTAT', 'SGA detailed statistics'],
      ['V$TABLESPACE', 'Tablespace information'],
      ['V$DATAFILE', 'Data file information'],
      ['V$TEMPFILE', 'Temporary file information'],
      ['V$LOG', 'Redo log groups'],
      ['V$LOGFILE', 'Redo log members'],
      ['V$ARCHIVED_LOG', 'Archived log information'],
      ['V$PROCESS', 'Background processes'],
      ['V$CONTROLFILE', 'Control files'],
      ['V$DIAG_INFO', 'Diagnostic repository info'],
      ['V$LOCK', 'Active locks'],
      ['V$LOCKED_OBJECT', 'Locked objects'],
      ['V$TRANSACTION', 'Active transactions'],
      ['V$SQL', 'SQL statements in cache'],
      ['V$SQLAREA', 'Shared SQL area statistics'],
      ['V$SQL_PLAN', 'SQL execution plans'],
      ['V$SYSSTAT', 'System statistics'],
      ['V$SESSTAT', 'Session statistics'],
      ['V$OPEN_CURSOR', 'Open cursors'],
      ['V$OPTION', 'Database options'],
      ['V$NLS_PARAMETERS', 'NLS parameters'],
      ['V$TIMEZONE_NAMES', 'Time zone names'],
      ['V$PGA_TARGET_ADVICE', 'PGA advisory information'],
      ['V$RESOURCE_LIMIT', 'Resource limits'],
      ['V$RECOVER_FILE', 'Files needing media recovery'],
      ['V$BACKUP', 'Online backup status'],
      // DBA_ dictionary views
      ['DBA_USERS', 'Database users'],
      ['DBA_ROLES', 'Database roles'],
      ['DBA_ROLE_PRIVS', 'Role privileges'],
      ['DBA_SYS_PRIVS', 'System privileges'],
      ['DBA_TAB_PRIVS', 'Object privileges'],
      ['DBA_TABLES', 'Database tables'],
      ['DBA_TAB_COLUMNS', 'Table columns'],
      ['DBA_OBJECTS', 'Database objects'],
      ['DBA_TABLESPACES', 'Tablespaces'],
      ['DBA_DATA_FILES', 'Data files'],
      ['DBA_TEMP_FILES', 'Temporary data files'],
      ['DBA_FREE_SPACE', 'Free extents in tablespaces'],
      ['DBA_INDEXES', 'Indexes'],
      ['DBA_IND_COLUMNS', 'Index columns'],
      ['DBA_CONSTRAINTS', 'Constraints'],
      ['DBA_CONS_COLUMNS', 'Constraint columns'],
      ['DBA_SEQUENCES', 'Sequences'],
      ['DBA_VIEWS', 'Views'],
      ['DBA_SOURCE', 'PL/SQL source code'],
      ['DBA_PROCEDURES', 'Stored procedures and functions'],
      ['DBA_TRIGGERS', 'Database triggers'],
      ['DBA_SEGMENTS', 'Storage segments'],
      ['DBA_EXTENTS', 'Data extents'],
      ['DBA_AUDIT_TRAIL', 'Audit trail entries'],
      ['DBA_STMT_AUDIT_OPTS', 'Auditing options for statements'],
      ['DBA_PROFILES', 'Resource limit profiles'],
      ['DBA_TAB_STATISTICS', 'Table statistics'],
      ['DBA_DIRECTORIES', 'Directory objects'],
      ['DBA_DB_LINKS', 'Database links'],
      ['DBA_JOBS', 'DBMS_JOB scheduled jobs'],
      ['DBA_SCHEDULER_JOBS', 'DBMS_SCHEDULER jobs'],
      ['DBA_SYNONYMS', 'Synonyms'],
      ['V$ASM_DISKGROUP', 'ASM disk groups'],
    ];
    return queryResult(
      [
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'COMMENTS', dataType: oracleVarchar2(4000) },
      ],
      views
    );
  }
}

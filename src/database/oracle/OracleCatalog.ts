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

export class OracleCatalog extends BaseCatalog {
  private storage: OracleStorage;
  private instance: OracleInstance;
  /** Schema → password (for authentication) */
  private passwords: Map<string, string> = new Map();

  constructor(storage: OracleStorage, instance: OracleInstance) {
    super();
    this.storage = storage;
    this.instance = instance;
    this.initDefaultUsersAndRoles();
  }

  private initDefaultUsersAndRoles(): void {
    const now = new Date();
    const defaultUsers: (CatalogUser & { password: string })[] = [
      { username: 'SYS', defaultTablespace: 'SYSTEM', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', created: now, profile: 'DEFAULT', password: 'oracle' },
      { username: 'SYSTEM', defaultTablespace: 'SYSTEM', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', created: now, profile: 'DEFAULT', password: 'oracle' },
      { username: 'DBSNMP', defaultTablespace: 'SYSAUX', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', created: now, profile: 'DEFAULT', password: 'dbsnmp' },
      { username: 'HR', defaultTablespace: 'USERS', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', created: now, profile: 'DEFAULT', password: 'hr' },
      { username: 'SCOTT', defaultTablespace: 'USERS', temporaryTablespace: 'TEMP', accountStatus: 'OPEN', created: now, profile: 'DEFAULT', password: 'tiger' },
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

    // HR and SCOTT get basic privileges
    for (const u of ['HR', 'SCOTT']) {
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
    const stored = this.passwords.get(username.toUpperCase());
    if (stored === undefined) return false;
    return stored === password;
  }

  setPassword(username: string, password: string): void {
    this.passwords.set(username.toUpperCase(), password);
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
      case 'V$SGA': return this.vSga();
      case 'V$TABLESPACE': return this.vTablespace();
      case 'V$DATAFILE': return this.vDatafile();
      case 'V$LOG': return this.vLog();
      case 'V$LOGFILE': return this.vLogfile();
      case 'V$PROCESS': return this.vProcess();
      case 'V$CONTROLFILE': return this.vControlfile();
      case 'V$DIAG_INFO': return this.vDiagInfo();
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
    return queryResult(
      [
        { name: 'SID', dataType: oracleNumber(10) },
        { name: 'SERIAL#', dataType: oracleNumber(10) },
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
        { name: 'PROGRAM', dataType: oracleVarchar2(64) },
        { name: 'TYPE', dataType: oracleVarchar2(10) },
        { name: 'LOGON_TIME', dataType: oracleDate() },
      ],
      [
        [1, 1, 'SYS', 'ACTIVE', 'oracle@localhost (PMON)', 'BACKGROUND', new Date().toISOString()],
        [2, 1, 'SYS', 'ACTIVE', 'oracle@localhost (SMON)', 'BACKGROUND', new Date().toISOString()],
        [10, 100, currentUser.toUpperCase(), 'ACTIVE', 'sqlplus@localhost', 'USER', new Date().toISOString()],
      ]
    );
  }

  private vParameter(): ResultSet {
    const params = this.instance.getAllParameters();
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(80) },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
        { name: 'ISDEFAULT', dataType: oracleVarchar2(9) },
      ],
      Array.from(params.entries()).map(([name, value]) => [name, value, 'TRUE'])
    );
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
    return queryResult(
      [
        { name: 'NAME', dataType: oracleVarchar2(64) },
        { name: 'VALUE', dataType: oracleVarchar2(512) },
      ],
      [
        ['Diag Trace', '/u01/app/oracle/diag/rdbms/orcl/ORCL/trace'],
        ['Diag Alert', '/u01/app/oracle/diag/rdbms/orcl/ORCL/trace'],
        ['Diag Incident', '/u01/app/oracle/diag/rdbms/orcl/ORCL/incident'],
        ['ADR Base', '/u01/app/oracle'],
        ['ADR Home', '/u01/app/oracle/diag/rdbms/orcl/ORCL'],
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
      default: return emptyResult(`View ${viewName} not implemented`);
    }
  }

  private dbaUsers(): ResultSet {
    const users = this.getAllUsers();
    return queryResult(
      [
        { name: 'USERNAME', dataType: oracleVarchar2(30) },
        { name: 'ACCOUNT_STATUS', dataType: oracleVarchar2(32) },
        { name: 'DEFAULT_TABLESPACE', dataType: oracleVarchar2(30) },
        { name: 'TEMPORARY_TABLESPACE', dataType: oracleVarchar2(30) },
        { name: 'CREATED', dataType: oracleDate() },
        { name: 'PROFILE', dataType: oracleVarchar2(30) },
      ],
      users.map(u => [u.username, u.accountStatus, u.defaultTablespace, u.temporaryTablespace, u.created.toISOString(), u.profile])
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
    // Add sequences
    for (const schema of this.storage.getSchemas()) {
      for (const idx of this.storage.getIndexes(schema)) {
        rows.push([schema, idx.name, 'INDEX', 'VALID']);
      }
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
        rows.push([schema, idx.name, idx.tableName, idx.unique ? 'UNIQUE' : 'NONUNIQUE', 'VALID']);
      }
    }
    return queryResult(
      [
        { name: 'OWNER', dataType: oracleVarchar2(30) },
        { name: 'INDEX_NAME', dataType: oracleVarchar2(30) },
        { name: 'TABLE_NAME', dataType: oracleVarchar2(30) },
        { name: 'UNIQUENESS', dataType: oracleVarchar2(9) },
        { name: 'STATUS', dataType: oracleVarchar2(8) },
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

  // ── DICTIONARY view ──────────────────────────────────────────────

  private queryDictionary(): ResultSet {
    const views = [
      ['V$VERSION', 'Oracle version information'],
      ['V$INSTANCE', 'Instance information'],
      ['V$DATABASE', 'Database information'],
      ['V$SESSION', 'Active sessions'],
      ['V$PARAMETER', 'System parameters'],
      ['V$SGA', 'SGA memory areas'],
      ['V$TABLESPACE', 'Tablespace information'],
      ['V$DATAFILE', 'Data file information'],
      ['V$LOG', 'Redo log groups'],
      ['V$LOGFILE', 'Redo log members'],
      ['V$PROCESS', 'Background processes'],
      ['V$CONTROLFILE', 'Control files'],
      ['DBA_USERS', 'Database users'],
      ['DBA_ROLES', 'Database roles'],
      ['DBA_ROLE_PRIVS', 'Role privileges'],
      ['DBA_SYS_PRIVS', 'System privileges'],
      ['DBA_TABLES', 'Database tables'],
      ['DBA_TAB_COLUMNS', 'Table columns'],
      ['DBA_OBJECTS', 'Database objects'],
      ['DBA_TABLESPACES', 'Tablespaces'],
      ['DBA_DATA_FILES', 'Data files'],
      ['DBA_INDEXES', 'Indexes'],
      ['DBA_CONSTRAINTS', 'Constraints'],
      ['DBA_SEQUENCES', 'Sequences'],
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

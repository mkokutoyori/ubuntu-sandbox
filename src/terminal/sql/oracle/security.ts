/**
 * Oracle Security Module - SQL-based implementation
 *
 * Uses actual SQL tables to store security data, just like a real Oracle database.
 * All security data is queryable via standard SQL SELECT statements.
 *
 * Core tables:
 * - SYS.USER$ - User accounts
 * - SYS.PROFILE$ - Security profiles
 * - SYS.ROLE$ - Role definitions
 * - SYS.SYSAUTH$ - System privileges granted
 * - SYS.OBJAUTH$ - Object privileges granted
 * - SYS.AUDIT$ - Audit trail
 */

import { SQLEngine } from '../generic/engine';
import { SQLResult, createSuccessResult, createErrorResult } from '../generic/types';
import { parseSQL } from '../generic/parser';

// ============================================================================
// Password Hashing
// ============================================================================

export function generateSalt(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let salt = '';
  for (let i = 0; i < 20; i++) {
    salt += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return salt;
}

export function hashPassword(password: string, salt?: string): string {
  const actualSalt = salt || generateSalt();
  let hash = 0;
  const combined = actualSalt + password;

  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const hashHex = Math.abs(hash).toString(16).toUpperCase().padStart(16, '0');
  return `S:${hashHex}${actualSalt}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash || !storedHash.startsWith('S:')) {
    return password === storedHash;
  }
  const salt = storedHash.slice(-20);
  const expectedHash = hashPassword(password, salt);
  return expectedHash === storedHash;
}

// ============================================================================
// SQL Schema Definitions for Security Tables
// ============================================================================

const SECURITY_SCHEMA_SQL = `
-- User accounts (maps to DBA_USERS view)
CREATE TABLE SYS.USER$ (
  USER_ID INTEGER PRIMARY KEY,
  USERNAME VARCHAR(128) NOT NULL UNIQUE,
  PASSWORD VARCHAR(256),
  ACCOUNT_STATUS VARCHAR(32) DEFAULT 'OPEN',
  LOCK_DATE TIMESTAMP,
  EXPIRY_DATE TIMESTAMP,
  DEFAULT_TABLESPACE VARCHAR(128) DEFAULT 'USERS',
  TEMPORARY_TABLESPACE VARCHAR(128) DEFAULT 'TEMP',
  PROFILE VARCHAR(128) DEFAULT 'DEFAULT',
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  LAST_LOGIN TIMESTAMP,
  FAILED_LOGIN_ATTEMPTS INTEGER DEFAULT 0
);

-- Security profiles (maps to DBA_PROFILES view)
CREATE TABLE SYS.PROFILE$ (
  PROFILE VARCHAR(128) NOT NULL,
  RESOURCE_NAME VARCHAR(128) NOT NULL,
  RESOURCE_TYPE VARCHAR(32),
  LIMIT VARCHAR(128),
  PRIMARY KEY (PROFILE, RESOURCE_NAME)
);

-- Roles (maps to DBA_ROLES view)
CREATE TABLE SYS.ROLE$ (
  ROLE_ID INTEGER PRIMARY KEY,
  ROLE VARCHAR(128) NOT NULL UNIQUE,
  PASSWORD_REQUIRED VARCHAR(1) DEFAULT 'N',
  PASSWORD VARCHAR(256),
  AUTHENTICATION_TYPE VARCHAR(32) DEFAULT 'NONE',
  CREATED_BY VARCHAR(128),
  CREATED TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- System privileges granted (maps to DBA_SYS_PRIVS view)
CREATE TABLE SYS.SYSAUTH$ (
  GRANTEE VARCHAR(128) NOT NULL,
  PRIVILEGE VARCHAR(128) NOT NULL,
  ADMIN_OPTION VARCHAR(3) DEFAULT 'NO',
  GRANTED_BY VARCHAR(128),
  GRANT_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (GRANTEE, PRIVILEGE)
);

-- Role privileges granted (maps to DBA_ROLE_PRIVS view)
CREATE TABLE SYS.ROLEAUTH$ (
  GRANTEE VARCHAR(128) NOT NULL,
  GRANTED_ROLE VARCHAR(128) NOT NULL,
  ADMIN_OPTION VARCHAR(3) DEFAULT 'NO',
  DEFAULT_ROLE VARCHAR(3) DEFAULT 'YES',
  GRANTED_BY VARCHAR(128),
  GRANT_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (GRANTEE, GRANTED_ROLE)
);

-- Object privileges granted (maps to DBA_TAB_PRIVS view)
CREATE TABLE SYS.OBJAUTH$ (
  GRANTEE VARCHAR(128) NOT NULL,
  OWNER VARCHAR(128) NOT NULL,
  TABLE_NAME VARCHAR(128) NOT NULL,
  PRIVILEGE VARCHAR(128) NOT NULL,
  GRANTABLE VARCHAR(3) DEFAULT 'NO',
  GRANTOR VARCHAR(128),
  GRANT_DATE TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (GRANTEE, OWNER, TABLE_NAME, PRIVILEGE)
);

-- Tablespace quotas (maps to DBA_TS_QUOTAS view)
CREATE TABLE SYS.TSQUOTA$ (
  USERNAME VARCHAR(128) NOT NULL,
  TABLESPACE_NAME VARCHAR(128) NOT NULL,
  MAX_BYTES INTEGER DEFAULT -1,
  PRIMARY KEY (USERNAME, TABLESPACE_NAME)
);

-- Audit trail (maps to DBA_AUDIT_TRAIL view)
CREATE TABLE SYS.AUD$ (
  AUDIT_ID INTEGER PRIMARY KEY,
  SESSION_ID INTEGER,
  TIMESTAMP TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  USERNAME VARCHAR(128),
  OS_USERNAME VARCHAR(255),
  TERMINAL VARCHAR(255),
  ACTION_NAME VARCHAR(128),
  OBJECT_SCHEMA VARCHAR(128),
  OBJECT_NAME VARCHAR(128),
  OBJECT_TYPE VARCHAR(32),
  SQL_TEXT VARCHAR(4000),
  RETURN_CODE INTEGER DEFAULT 0,
  CLIENT_ID VARCHAR(255),
  COMMENT_TEXT VARCHAR(4000)
);

-- Audit policies (maps to DBA_STMT_AUDIT_OPTS view)
CREATE TABLE SYS.AUDIT$ (
  USER_NAME VARCHAR(128),
  AUDIT_OPTION VARCHAR(128) NOT NULL,
  SUCCESS VARCHAR(10),
  FAILURE VARCHAR(10),
  PRIMARY KEY (AUDIT_OPTION)
);
`;

// ============================================================================
// Initial Data Population
// ============================================================================

function getInitialDataSQL(): string[] {
  const statements: string[] = [];
  const now = new Date().toISOString();

  // Create profiles
  const profileSettings = [
    { profile: 'DEFAULT', resource: 'SESSIONS_PER_USER', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'CPU_PER_SESSION', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'CONNECT_TIME', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'IDLE_TIME', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'FAILED_LOGIN_ATTEMPTS', value: '10' },
    { profile: 'DEFAULT', resource: 'PASSWORD_LIFE_TIME', value: '180' },
    { profile: 'DEFAULT', resource: 'PASSWORD_REUSE_TIME', value: 'UNLIMITED' },
    { profile: 'DEFAULT', resource: 'PASSWORD_LOCK_TIME', value: '1' },
    { profile: 'DEFAULT', resource: 'PASSWORD_GRACE_TIME', value: '7' },
    { profile: 'SECURE_PROFILE', resource: 'FAILED_LOGIN_ATTEMPTS', value: '3' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_LIFE_TIME', value: '60' },
    { profile: 'SECURE_PROFILE', resource: 'PASSWORD_LOCK_TIME', value: '1' },
    { profile: 'SECURE_PROFILE', resource: 'CONNECT_TIME', value: '480' },
    { profile: 'SECURE_PROFILE', resource: 'IDLE_TIME', value: '30' },
  ];

  for (const p of profileSettings) {
    statements.push(
      `INSERT INTO PROFILE$ (PROFILE_NAME, RESOURCE_NAME, RESOURCE_TYPE, LIMIT_VALUE) ` +
      `VALUES ('${p.profile}', '${p.resource}', 'PASSWORD', '${p.value}')`
    );
  }

  // Create system users
  const users = [
    { id: 0, name: 'SYS', password: hashPassword('oracle'), status: 'OPEN' },
    { id: 1, name: 'SYSTEM', password: hashPassword('oracle'), status: 'OPEN' },
    { id: 2, name: 'SCOTT', password: hashPassword('tiger'), status: 'OPEN' },
    { id: 3, name: 'HR', password: hashPassword('hr'), status: 'OPEN' },
  ];

  for (const u of users) {
    statements.push(
      `INSERT INTO USER$ (USER_ID, USERNAME, PASSWORD_HASH, ACCOUNT_STATUS, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE, USER_PROFILE, CREATED, FAILED_LOGIN_ATTEMPTS) ` +
      `VALUES (${u.id}, '${u.name}', '${u.password}', '${u.status}', '${u.name === 'SYS' || u.name === 'SYSTEM' ? 'SYSTEM' : 'USERS'}', 'TEMP', 'DEFAULT', '${now}', 0)`
    );
  }

  // Create roles
  const roles = [
    { id: 1, name: 'CONNECT', createdBy: 'SYS' },
    { id: 2, name: 'RESOURCE', createdBy: 'SYS' },
    { id: 3, name: 'DBA', createdBy: 'SYS' },
    { id: 4, name: 'SELECT_CATALOG_ROLE', createdBy: 'SYS' },
    { id: 5, name: 'EXECUTE_CATALOG_ROLE', createdBy: 'SYS' },
  ];

  for (const r of roles) {
    statements.push(
      `INSERT INTO ROLE$ (ROLE_ID, ROLE_NAME, PASSWORD_REQUIRED, AUTHENTICATION_TYPE, CREATED_BY, CREATED) ` +
      `VALUES (${r.id}, '${r.name}', 'N', 'NONE', '${r.createdBy}', '${now}')`
    );
  }

  // Grant privileges to roles
  const rolePrivs = [
    { role: 'CONNECT', priv: 'CREATE SESSION' },
    { role: 'RESOURCE', priv: 'CREATE TABLE' },
    { role: 'RESOURCE', priv: 'CREATE SEQUENCE' },
    { role: 'RESOURCE', priv: 'CREATE PROCEDURE' },
    { role: 'RESOURCE', priv: 'CREATE TRIGGER' },
    { role: 'DBA', priv: 'CREATE SESSION' },
    { role: 'DBA', priv: 'CREATE USER' },
    { role: 'DBA', priv: 'ALTER USER' },
    { role: 'DBA', priv: 'DROP USER' },
    { role: 'DBA', priv: 'CREATE ROLE' },
    { role: 'DBA', priv: 'DROP ANY ROLE' },
    { role: 'DBA', priv: 'GRANT ANY ROLE' },
    { role: 'DBA', priv: 'CREATE TABLE' },
    { role: 'DBA', priv: 'CREATE ANY TABLE' },
    { role: 'DBA', priv: 'ALTER ANY TABLE' },
    { role: 'DBA', priv: 'DROP ANY TABLE' },
    { role: 'DBA', priv: 'SELECT ANY TABLE' },
    { role: 'DBA', priv: 'INSERT ANY TABLE' },
    { role: 'DBA', priv: 'UPDATE ANY TABLE' },
    { role: 'DBA', priv: 'DELETE ANY TABLE' },
    { role: 'DBA', priv: 'CREATE SEQUENCE' },
    { role: 'DBA', priv: 'CREATE ANY SEQUENCE' },
    { role: 'DBA', priv: 'GRANT ANY PRIVILEGE' },
    { role: 'DBA', priv: 'GRANT ANY OBJECT PRIVILEGE' },
    { role: 'DBA', priv: 'AUDIT ANY' },
  ];

  for (const rp of rolePrivs) {
    statements.push(
      `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${rp.role}', '${rp.priv}', 'YES', 'SYS', '${now}')`
    );
  }

  // Grant roles to users
  const userRoles = [
    { grantee: 'SYS', role: 'DBA' },
    { grantee: 'SYSTEM', role: 'DBA' },
    { grantee: 'SCOTT', role: 'CONNECT' },
    { grantee: 'SCOTT', role: 'RESOURCE' },
    { grantee: 'HR', role: 'CONNECT' },
    { grantee: 'HR', role: 'RESOURCE' },
  ];

  for (const ur of userRoles) {
    statements.push(
      `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${ur.grantee}', '${ur.role}', 'NO', 'YES', 'SYS', '${now}')`
    );
  }

  // Grant DBA nested roles
  statements.push(
    `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('DBA', 'CONNECT', 'YES', 'YES', 'SYS', '${now}')`
  );
  statements.push(
    `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('DBA', 'RESOURCE', 'YES', 'YES', 'SYS', '${now}')`
  );

  // Grant SYSDBA to SYS
  statements.push(
    `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('SYS', 'SYSDBA', 'YES', 'SYS', '${now}')`
  );
  statements.push(
    `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
    `VALUES ('SYS', 'SYSOPER', 'YES', 'SYS', '${now}')`
  );

  return statements;
}

// ============================================================================
// Oracle Security Manager - SQL-based
// ============================================================================

export class OracleSecurityManager {
  private engine: SQLEngine;
  private initialized: boolean = false;
  private currentSessionId: number = 1;
  private auditSequence: number = 1;
  private userSequence: number = 100;
  private roleSequence: number = 100;

  constructor(engine?: SQLEngine) {
    if (engine) {
      this.engine = engine;
      this.initializeSecurityTables();
    }
  }

  /**
   * Set the SQL engine (for deferred initialization)
   */
  setEngine(engine: SQLEngine): void {
    this.engine = engine;
    if (!this.initialized) {
      this.initializeSecurityTables();
    }
  }

  /**
   * Initialize security tables in the database
   */
  private initializeSecurityTables(): void {
    if (this.initialized || !this.engine) return;

    // Create SYS schema if not exists
    this.engine.createSchema('SYS');
    const originalSchema = this.engine.getCurrentSchema();
    this.engine.setCurrentSchema('SYS');

    // Create security tables
    const tables = [
      {
        name: 'USER$',
        columns: [
          { name: 'USER_ID', dataType: 'INTEGER', nullable: false },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PASSWORD_HASH', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'ACCOUNT_STATUS', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'OPEN' },
          { name: 'LOCK_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'EXPIRY_DATE', dataType: 'TIMESTAMP', nullable: true },
          { name: 'DEFAULT_TABLESPACE', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'USERS' },
          { name: 'TEMPORARY_TABLESPACE', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'TEMP' },
          { name: 'USER_PROFILE', dataType: 'VARCHAR', length: 128, nullable: true, defaultValue: 'DEFAULT' },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
          { name: 'LAST_LOGIN', dataType: 'TIMESTAMP', nullable: true },
          { name: 'FAILED_LOGIN_ATTEMPTS', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
        ],
        primaryKey: ['USER_ID']
      },
      {
        name: 'PROFILE$',
        columns: [
          { name: 'PROFILE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'RESOURCE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'RESOURCE_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'LIMIT_VALUE', dataType: 'VARCHAR', length: 128, nullable: true },
        ],
        primaryKey: ['PROFILE_NAME', 'RESOURCE_NAME']
      },
      {
        name: 'ROLE$',
        columns: [
          { name: 'ROLE_ID', dataType: 'INTEGER', nullable: false },
          { name: 'ROLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PASSWORD_REQUIRED', dataType: 'VARCHAR', length: 1, nullable: true, defaultValue: 'N' },
          { name: 'PASSWORD_HASH', dataType: 'VARCHAR', length: 256, nullable: true },
          { name: 'AUTHENTICATION_TYPE', dataType: 'VARCHAR', length: 32, nullable: true, defaultValue: 'NONE' },
          { name: 'CREATED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'CREATED', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['ROLE_ID']
      },
      {
        name: 'SYSAUTH$',
        columns: [
          { name: 'GRANTEE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PRIVILEGE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'ADMIN_OPTION', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'GRANTED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'GRANT_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['GRANTEE', 'PRIVILEGE']
      },
      {
        name: 'ROLEAUTH$',
        columns: [
          { name: 'GRANTEE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'GRANTED_ROLE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'ADMIN_OPTION', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'DEFAULT_ROLE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'YES' },
          { name: 'GRANTED_BY', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'GRANT_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['GRANTEE', 'GRANTED_ROLE']
      },
      {
        name: 'OBJAUTH$',
        columns: [
          { name: 'GRANTEE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'OWNER', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'PRIVILEGE', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'GRANTABLE', dataType: 'VARCHAR', length: 3, nullable: true, defaultValue: 'NO' },
          { name: 'GRANTOR', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'GRANT_DATE', dataType: 'TIMESTAMP', nullable: true },
        ],
        primaryKey: ['GRANTEE', 'OWNER', 'TABLE_NAME', 'PRIVILEGE']
      },
      {
        name: 'TSQUOTA$',
        columns: [
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'TABLESPACE_NAME', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'MAX_BYTES', dataType: 'INTEGER', nullable: true, defaultValue: -1 },
        ],
        primaryKey: ['USERNAME', 'TABLESPACE_NAME']
      },
      {
        name: 'AUD$',
        columns: [
          { name: 'AUDIT_ID', dataType: 'INTEGER', nullable: false },
          { name: 'SESSION_ID', dataType: 'INTEGER', nullable: true },
          { name: 'EVENT_TIME', dataType: 'TIMESTAMP', nullable: true },
          { name: 'USERNAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OS_USERNAME', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'TERMINAL', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'ACTION_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_SCHEMA', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'OBJECT_TYPE', dataType: 'VARCHAR', length: 32, nullable: true },
          { name: 'SQL_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
          { name: 'RETURN_CODE', dataType: 'INTEGER', nullable: true, defaultValue: 0 },
          { name: 'CLIENT_ID', dataType: 'VARCHAR', length: 255, nullable: true },
          { name: 'COMMENT_TEXT', dataType: 'VARCHAR', length: 4000, nullable: true },
        ],
        primaryKey: ['AUDIT_ID']
      },
      {
        name: 'AUDIT$',
        columns: [
          { name: 'USER_NAME', dataType: 'VARCHAR', length: 128, nullable: true },
          { name: 'AUDIT_OPTION', dataType: 'VARCHAR', length: 128, nullable: false },
          { name: 'SUCCESS', dataType: 'VARCHAR', length: 10, nullable: true },
          { name: 'FAILURE', dataType: 'VARCHAR', length: 10, nullable: true },
        ],
        primaryKey: ['AUDIT_OPTION']
      },
    ];

    for (const tableDef of tables) {
      this.engine.createTable({
        type: 'CREATE_TABLE',
        table: tableDef.name,
        schema: 'SYS',
        columns: tableDef.columns,
        primaryKey: tableDef.primaryKey,
        foreignKeys: [],
        uniqueConstraints: [],
        checkConstraints: [],
        ifNotExists: true
      });
    }

    // Insert initial data
    const initStatements = getInitialDataSQL();
    for (const sql of initStatements) {
      try {
        this.executeSQL(sql);
      } catch (e) {
        // Ignore duplicate key errors during initialization
      }
    }

    this.engine.setCurrentSchema(originalSchema);
    this.initialized = true;
  }

  /**
   * Execute SQL on the security tables
   */
  private executeSQL(sql: string): SQLResult {
    const originalSchema = this.engine.getCurrentSchema();
    this.engine.setCurrentSchema('SYS');

    try {
      // Parse and execute
      const parseResult = parseSQL(sql);

      if (!parseResult.success || parseResult.statements.length === 0) {
        return createErrorResult('PARSE_ERROR', 'Failed to parse SQL');
      }

      const stmt = parseResult.statements[0];
      let result: SQLResult;

      switch (stmt.type) {
        case 'SELECT':
          result = this.engine.executeSelect(stmt);
          break;
        case 'INSERT':
          result = this.engine.executeInsert(stmt);
          break;
        case 'UPDATE':
          result = this.engine.executeUpdate(stmt);
          break;
        case 'DELETE':
          result = this.engine.executeDelete(stmt);
          break;
        default:
          result = createSuccessResult();
      }

      return result;
    } finally {
      this.engine.setCurrentSchema(originalSchema);
    }
  }

  /**
   * Query a security table
   */
  private queryTable(sql: string): any[] {
    const result = this.executeSQL(sql);
    if (result.success && result.resultSet) {
      return result.resultSet.rows;
    }
    return [];
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  authenticate(username: string, password: string, options?: {
    osUser?: string;
    terminal?: string;
    clientIp?: string;
  }): { success: boolean; error?: string; sessionId?: number } {
    const upperUsername = username.toUpperCase();

    // Query user from database
    const users = this.queryTable(
      `SELECT USER_ID, USERNAME, PASSWORD_HASH, ACCOUNT_STATUS, USER_PROFILE, FAILED_LOGIN_ATTEMPTS ` +
      `FROM USER$ WHERE USERNAME = '${upperUsername}'`
    );

    if (users.length === 0) {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 1017, comment: 'User does not exist' });
      return { success: false, error: 'ORA-01017: invalid username/password; logon denied' };
    }

    const user = users[0];

    // Check account status
    if (user.ACCOUNT_STATUS === 'LOCKED' || user.ACCOUNT_STATUS === 'EXPIRED & LOCKED') {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 28000, comment: 'Account is locked' });
      return { success: false, error: 'ORA-28000: the account is locked' };
    }

    // Verify password
    if (!verifyPassword(password, user.PASSWORD_HASH)) {
      const attempts = (user.FAILED_LOGIN_ATTEMPTS || 0) + 1;

      // Update failed attempts
      this.executeSQL(
        `UPDATE USER$ SET FAILED_LOGIN_ATTEMPTS = ${attempts} WHERE USERNAME = '${upperUsername}'`
      );

      // Get max attempts from profile
      const profileRows = this.queryTable(
        `SELECT LIMIT_VALUE FROM PROFILE$ WHERE PROFILE_NAME = '${user.USER_PROFILE || 'DEFAULT'}' AND RESOURCE_NAME = 'FAILED_LOGIN_ATTEMPTS'`
      );
      const maxAttempts = profileRows.length > 0 && profileRows[0].LIMIT_VALUE !== 'UNLIMITED'
        ? parseInt(profileRows[0].LIMIT_VALUE, 10)
        : 10;

      if (attempts >= maxAttempts) {
        this.executeSQL(
          `UPDATE USER$ SET ACCOUNT_STATUS = 'LOCKED', LOCK_DATE = '${new Date().toISOString()}' WHERE USERNAME = '${upperUsername}'`
        );
        this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 28000, comment: `Account locked after ${attempts} failed attempts` });
        return { success: false, error: 'ORA-28000: the account is locked' };
      }

      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 1017, comment: `Failed attempt ${attempts}` });
      return { success: false, error: 'ORA-01017: invalid username/password; logon denied' };
    }

    // Check password expiration
    if (user.ACCOUNT_STATUS === 'EXPIRED') {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 28001, comment: 'Password expired' });
      return { success: false, error: 'ORA-28001: the password has expired' };
    }

    // Check CREATE SESSION privilege
    if (!this.hasPrivilege(upperUsername, 'CREATE SESSION')) {
      this.auditAction('LOGON_FAILED', upperUsername, { returnCode: 1045, comment: 'Lacks CREATE SESSION privilege' });
      return { success: false, error: 'ORA-01045: user lacks CREATE SESSION privilege; logon denied' };
    }

    // Success - reset failed attempts and update last login
    this.executeSQL(
      `UPDATE USER$ SET FAILED_LOGIN_ATTEMPTS = 0, LAST_LOGIN = '${new Date().toISOString()}' WHERE USERNAME = '${upperUsername}'`
    );

    const sessionId = this.currentSessionId++;
    this.auditAction('LOGON', upperUsername, { sessionId, returnCode: 0 });

    return { success: true, sessionId };
  }

  logout(username: string, sessionId: number): void {
    this.auditAction('LOGOFF', username.toUpperCase(), { sessionId, returnCode: 0 });
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  createUser(
    username: string,
    password: string,
    options?: {
      defaultTablespace?: string;
      temporaryTablespace?: string;
      profile?: string;
      quota?: Map<string, number | 'UNLIMITED'>;
      accountLocked?: boolean;
      passwordExpire?: boolean;
    },
    createdBy?: string
  ): SQLResult {
    const upperUsername = username.toUpperCase();

    // Check if user already exists
    const existing = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperUsername}'`);
    if (existing.length > 0) {
      return createErrorResult('01920', `ORA-01920: user name '${upperUsername}' conflicts with another user or role name`);
    }

    // Check if conflicts with role
    const roleConflict = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperUsername}'`);
    if (roleConflict.length > 0) {
      return createErrorResult('01920', `ORA-01920: user name '${upperUsername}' conflicts with another user or role name`);
    }

    const userId = this.userSequence++;
    const hashedPassword = hashPassword(password);
    const status = options?.accountLocked ? 'LOCKED' : (options?.passwordExpire ? 'EXPIRED' : 'OPEN');
    const now = new Date().toISOString();

    const result = this.executeSQL(
      `INSERT INTO USER$ (USER_ID, USERNAME, PASSWORD_HASH, ACCOUNT_STATUS, DEFAULT_TABLESPACE, TEMPORARY_TABLESPACE, USER_PROFILE, CREATED, FAILED_LOGIN_ATTEMPTS) ` +
      `VALUES (${userId}, '${upperUsername}', '${hashedPassword}', '${status}', '${options?.defaultTablespace || 'USERS'}', '${options?.temporaryTablespace || 'TEMP'}', '${options?.profile || 'DEFAULT'}', '${now}', 0)`
    );

    if (result.success) {
      this.auditAction('CREATE_USER', createdBy || 'SYSTEM', {
        objectName: upperUsername,
        objectType: 'USER',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  alterUser(
    username: string,
    changes: {
      password?: string;
      defaultTablespace?: string;
      temporaryTablespace?: string;
      profile?: string;
      accountLock?: boolean;
      accountUnlock?: boolean;
      passwordExpire?: boolean;
    },
    alteredBy?: string
  ): SQLResult {
    const upperUsername = username.toUpperCase();

    // Check user exists
    const existing = this.queryTable(`SELECT ACCOUNT_STATUS FROM USER$ WHERE USERNAME = '${upperUsername}'`);
    if (existing.length === 0) {
      return createErrorResult('01918', `ORA-01918: user '${upperUsername}' does not exist`);
    }

    const updates: string[] = [];

    if (changes.password !== undefined) {
      updates.push(`PASSWORD_HASH = '${hashPassword(changes.password)}'`);
      if (existing[0].ACCOUNT_STATUS === 'EXPIRED') {
        updates.push(`ACCOUNT_STATUS = 'OPEN'`);
      }
    }

    if (changes.defaultTablespace !== undefined) {
      updates.push(`DEFAULT_TABLESPACE = '${changes.defaultTablespace}'`);
    }

    if (changes.temporaryTablespace !== undefined) {
      updates.push(`TEMPORARY_TABLESPACE = '${changes.temporaryTablespace}'`);
    }

    if (changes.profile !== undefined) {
      updates.push(`USER_PROFILE = '${changes.profile}'`);
    }

    if (changes.accountLock) {
      updates.push(`ACCOUNT_STATUS = 'LOCKED'`);
      updates.push(`LOCK_DATE = '${new Date().toISOString()}'`);
    }

    if (changes.accountUnlock) {
      const currentStatus = existing[0].ACCOUNT_STATUS;
      if (currentStatus === 'LOCKED') {
        updates.push(`ACCOUNT_STATUS = 'OPEN'`);
      } else if (currentStatus === 'EXPIRED & LOCKED') {
        updates.push(`ACCOUNT_STATUS = 'EXPIRED'`);
      }
      updates.push(`LOCK_DATE = NULL`);
      updates.push(`FAILED_LOGIN_ATTEMPTS = 0`);
    }

    if (changes.passwordExpire) {
      const currentStatus = existing[0].ACCOUNT_STATUS;
      if (currentStatus === 'LOCKED') {
        updates.push(`ACCOUNT_STATUS = 'EXPIRED & LOCKED'`);
      } else {
        updates.push(`ACCOUNT_STATUS = 'EXPIRED'`);
      }
      updates.push(`EXPIRY_DATE = '${new Date().toISOString()}'`);
    }

    if (updates.length === 0) {
      return createSuccessResult();
    }

    const result = this.executeSQL(
      `UPDATE USER$ SET ${updates.join(', ')} WHERE USERNAME = '${upperUsername}'`
    );

    if (result.success) {
      this.auditAction('ALTER_USER', alteredBy || 'SYSTEM', {
        objectName: upperUsername,
        objectType: 'USER',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  dropUser(username: string, cascade: boolean = false, droppedBy?: string): SQLResult {
    const upperUsername = username.toUpperCase();

    // Prevent dropping system users
    if (['SYS', 'SYSTEM', 'PUBLIC'].includes(upperUsername)) {
      return createErrorResult('01031', `ORA-01031: insufficient privileges to drop ${upperUsername}`);
    }

    // Check user exists
    const existing = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperUsername}'`);
    if (existing.length === 0) {
      return createErrorResult('01918', `ORA-01918: user '${upperUsername}' does not exist`);
    }

    // Delete user and related data
    this.executeSQL(`DELETE FROM ROLEAUTH$ WHERE GRANTEE = '${upperUsername}'`);
    this.executeSQL(`DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}'`);
    this.executeSQL(`DELETE FROM OBJAUTH$ WHERE GRANTEE = '${upperUsername}'`);
    this.executeSQL(`DELETE FROM TSQUOTA$ WHERE USERNAME = '${upperUsername}'`);

    const result = this.executeSQL(`DELETE FROM USER$ WHERE USERNAME = '${upperUsername}'`);

    if (result.success) {
      this.auditAction('DROP_USER', droppedBy || 'SYSTEM', {
        objectName: upperUsername,
        objectType: 'USER',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  // ==========================================================================
  // Role Management
  // ==========================================================================

  createRole(roleName: string, password?: string, createdBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();

    // Check conflicts
    const roleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);
    if (roleExists.length > 0) {
      return createErrorResult('01921', `ORA-01921: role name '${upperRoleName}' conflicts with another user or role name`);
    }

    const userExists = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperRoleName}'`);
    if (userExists.length > 0) {
      return createErrorResult('01921', `ORA-01921: role name '${upperRoleName}' conflicts with another user or role name`);
    }

    const roleId = this.roleSequence++;
    const now = new Date().toISOString();
    const hashedPassword = password ? hashPassword(password) : '';
    const passwordRequired = password ? 'Y' : 'N';

    const result = this.executeSQL(
      `INSERT INTO ROLE$ (ROLE_ID, ROLE_NAME, PASSWORD_REQUIRED, PASSWORD_HASH, AUTHENTICATION_TYPE, CREATED_BY, CREATED) ` +
      `VALUES (${roleId}, '${upperRoleName}', '${passwordRequired}', '${hashedPassword}', '${password ? 'PASSWORD' : 'NONE'}', '${createdBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('CREATE_ROLE', createdBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  dropRole(roleName: string, droppedBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();

    // Check role exists
    const existing = this.queryTable(`SELECT CREATED_BY FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);
    if (existing.length === 0) {
      return createErrorResult('01919', `ORA-01919: role '${upperRoleName}' does not exist`);
    }

    // Prevent dropping built-in roles
    if (['CONNECT', 'RESOURCE', 'DBA'].includes(upperRoleName) && existing[0].CREATED_BY === 'SYS') {
      return createErrorResult('01031', `ORA-01031: insufficient privileges to drop built-in role ${upperRoleName}`);
    }

    // Remove role from all grantees
    this.executeSQL(`DELETE FROM ROLEAUTH$ WHERE GRANTED_ROLE = '${upperRoleName}'`);
    this.executeSQL(`DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperRoleName}'`);

    const result = this.executeSQL(`DELETE FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);

    if (result.success) {
      this.auditAction('DROP_ROLE', droppedBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  // ==========================================================================
  // Privilege Management
  // ==========================================================================

  grantSystemPrivilege(
    privilege: string,
    grantee: string,
    withAdminOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const now = new Date().toISOString();

    // Check grantee exists (user or role)
    const userExists = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperGrantee}'`);
    const roleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperGrantee}'`);

    if (userExists.length === 0 && roleExists.length === 0) {
      return createErrorResult('01917', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    // Delete existing grant first (to handle update of admin option)
    this.executeSQL(`DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperGrantee}' AND PRIVILEGE = '${upperPrivilege}'`);

    const result = this.executeSQL(
      `INSERT INTO SYSAUTH$ (GRANTEE, PRIVILEGE, ADMIN_OPTION, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${upperGrantee}', '${upperPrivilege}', '${withAdminOption ? 'YES' : 'NO'}', '${grantedBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('GRANT', grantedBy || 'SYSTEM', {
        objectName: upperPrivilege,
        objectType: 'SYSTEM PRIVILEGE',
        comment: `Granted to ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  revokeSystemPrivilege(privilege: string, grantee: string, revokedBy?: string): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const result = this.executeSQL(
      `DELETE FROM SYSAUTH$ WHERE GRANTEE = '${upperGrantee}' AND PRIVILEGE = '${upperPrivilege}'`
    );

    if (result.success) {
      this.auditAction('REVOKE', revokedBy || 'SYSTEM', {
        objectName: upperPrivilege,
        objectType: 'SYSTEM PRIVILEGE',
        comment: `Revoked from ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  grantRole(
    roleName: string,
    grantee: string,
    withAdminOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperRoleName = roleName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const now = new Date().toISOString();

    // Check role exists
    const roleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperRoleName}'`);
    if (roleExists.length === 0) {
      return createErrorResult('01919', `ORA-01919: role '${upperRoleName}' does not exist`);
    }

    // Check grantee exists
    const userExists = this.queryTable(`SELECT 1 FROM USER$ WHERE USERNAME = '${upperGrantee}'`);
    const granteeRoleExists = this.queryTable(`SELECT 1 FROM ROLE$ WHERE ROLE_NAME = '${upperGrantee}'`);

    if (userExists.length === 0 && granteeRoleExists.length === 0) {
      return createErrorResult('01917', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    // Check for circular grant
    if (granteeRoleExists.length > 0 && this.wouldCreateCircularGrant(upperRoleName, upperGrantee)) {
      return createErrorResult('01934', `ORA-01934: circular role grant detected`);
    }

    // Delete existing grant first
    this.executeSQL(`DELETE FROM ROLEAUTH$ WHERE GRANTEE = '${upperGrantee}' AND GRANTED_ROLE = '${upperRoleName}'`);

    const result = this.executeSQL(
      `INSERT INTO ROLEAUTH$ (GRANTEE, GRANTED_ROLE, ADMIN_OPTION, DEFAULT_ROLE, GRANTED_BY, GRANT_DATE) ` +
      `VALUES ('${upperGrantee}', '${upperRoleName}', '${withAdminOption ? 'YES' : 'NO'}', 'YES', '${grantedBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('GRANT', grantedBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        comment: `Granted to ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  revokeRole(roleName: string, grantee: string, revokedBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const result = this.executeSQL(
      `DELETE FROM ROLEAUTH$ WHERE GRANTEE = '${upperGrantee}' AND GRANTED_ROLE = '${upperRoleName}'`
    );

    if (result.success) {
      this.auditAction('REVOKE', revokedBy || 'SYSTEM', {
        objectName: upperRoleName,
        objectType: 'ROLE',
        comment: `Revoked from ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  grantObjectPrivilege(
    privilege: string,
    objectOwner: string,
    objectName: string,
    grantee: string,
    withGrantOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperOwner = objectOwner.toUpperCase();
    const upperObject = objectName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const now = new Date().toISOString();

    // Delete existing grant first
    this.executeSQL(
      `DELETE FROM OBJAUTH$ WHERE GRANTEE = '${upperGrantee}' AND OWNER = '${upperOwner}' ` +
      `AND TABLE_NAME = '${upperObject}' AND PRIVILEGE = '${upperPrivilege}'`
    );

    const result = this.executeSQL(
      `INSERT INTO OBJAUTH$ (GRANTEE, OWNER, TABLE_NAME, PRIVILEGE, GRANTABLE, GRANTOR, GRANT_DATE) ` +
      `VALUES ('${upperGrantee}', '${upperOwner}', '${upperObject}', '${upperPrivilege}', '${withGrantOption ? 'YES' : 'NO'}', '${grantedBy || 'SYSTEM'}', '${now}')`
    );

    if (result.success) {
      this.auditAction('GRANT', grantedBy || 'SYSTEM', {
        objectSchema: upperOwner,
        objectName: upperObject,
        objectType: 'OBJECT PRIVILEGE',
        comment: `${upperPrivilege} granted to ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  revokeObjectPrivilege(
    privilege: string,
    objectOwner: string,
    objectName: string,
    grantee: string,
    revokedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperOwner = objectOwner.toUpperCase();
    const upperObject = objectName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const result = this.executeSQL(
      `DELETE FROM OBJAUTH$ WHERE GRANTEE = '${upperGrantee}' AND OWNER = '${upperOwner}' ` +
      `AND TABLE_NAME = '${upperObject}' AND PRIVILEGE = '${upperPrivilege}'`
    );

    if (result.success) {
      this.auditAction('REVOKE', revokedBy || 'SYSTEM', {
        objectSchema: upperOwner,
        objectName: upperObject,
        objectType: 'OBJECT PRIVILEGE',
        comment: `${upperPrivilege} revoked from ${upperGrantee}`,
        returnCode: 0
      });
    }

    return result.success ? createSuccessResult() : result;
  }

  // ==========================================================================
  // Privilege Checking
  // ==========================================================================

  hasPrivilege(username: string, privilege: string): boolean {
    const upperUsername = username.toUpperCase();
    const upperPrivilege = privilege.toUpperCase();

    // SYS has all privileges
    if (upperUsername === 'SYS') {
      return true;
    }

    // Check for SYSDBA
    const sysdba = this.queryTable(
      `SELECT 1 FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}' AND PRIVILEGE = 'SYSDBA'`
    );
    if (sysdba.length > 0) {
      return true;
    }

    // Check direct privilege
    const directPriv = this.queryTable(
      `SELECT 1 FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}' AND PRIVILEGE = '${upperPrivilege}'`
    );
    if (directPriv.length > 0) {
      return true;
    }

    // Check privileges from roles (recursively)
    return this.hasPrivilegeFromRoles(upperUsername, upperPrivilege, new Set());
  }

  private hasPrivilegeFromRoles(grantee: string, privilege: string, visited: Set<string>): boolean {
    // Get all roles granted to this grantee
    const roles = this.queryTable(
      `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${grantee}'`
    );

    for (const row of roles) {
      const roleName = row.GRANTED_ROLE;
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      // Check if role has the privilege
      const rolePriv = this.queryTable(
        `SELECT 1 FROM SYSAUTH$ WHERE GRANTEE = '${roleName}' AND PRIVILEGE = '${privilege}'`
      );
      if (rolePriv.length > 0) {
        return true;
      }

      // Check nested roles
      if (this.hasPrivilegeFromRoles(roleName, privilege, visited)) {
        return true;
      }
    }

    return false;
  }

  hasObjectPrivilege(
    username: string,
    privilege: string,
    objectOwner: string,
    objectName: string
  ): boolean {
    const upperUsername = username.toUpperCase();
    const upperPrivilege = privilege.toUpperCase();
    const upperOwner = objectOwner.toUpperCase();
    const upperObject = objectName.toUpperCase();

    // Owner has all privileges on their objects
    if (upperUsername === upperOwner) {
      return true;
    }

    // SYS has all privileges
    if (upperUsername === 'SYS') {
      return true;
    }

    // Check for ANY privilege
    const anyPrivilege = `${upperPrivilege} ANY TABLE`;
    if (this.hasPrivilege(upperUsername, anyPrivilege)) {
      return true;
    }

    // Check direct object privilege
    const directObjPriv = this.queryTable(
      `SELECT 1 FROM OBJAUTH$ WHERE GRANTEE = '${upperUsername}' AND OWNER = '${upperOwner}' ` +
      `AND TABLE_NAME = '${upperObject}' AND (PRIVILEGE = '${upperPrivilege}' OR PRIVILEGE = 'ALL')`
    );
    if (directObjPriv.length > 0) {
      return true;
    }

    // Check object privileges from roles
    return this.hasObjectPrivilegeFromRoles(upperUsername, upperPrivilege, upperOwner, upperObject, new Set());
  }

  private hasObjectPrivilegeFromRoles(
    grantee: string,
    privilege: string,
    objectOwner: string,
    objectName: string,
    visited: Set<string>
  ): boolean {
    const roles = this.queryTable(
      `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${grantee}'`
    );

    for (const row of roles) {
      const roleName = row.GRANTED_ROLE;
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      // Check if role has the object privilege
      const roleObjPriv = this.queryTable(
        `SELECT 1 FROM OBJAUTH$ WHERE GRANTEE = '${roleName}' AND OWNER = '${objectOwner}' ` +
        `AND TABLE_NAME = '${objectName}' AND (PRIVILEGE = '${privilege}' OR PRIVILEGE = 'ALL')`
      );
      if (roleObjPriv.length > 0) {
        return true;
      }

      // Check nested roles
      if (this.hasObjectPrivilegeFromRoles(roleName, privilege, objectOwner, objectName, visited)) {
        return true;
      }
    }

    return false;
  }

  private wouldCreateCircularGrant(roleName: string, targetRole: string): boolean {
    if (roleName === targetRole) return true;

    const visited = new Set<string>();
    const queue = [roleName];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetRole) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const nestedRoles = this.queryTable(
        `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${current}'`
      );
      for (const row of nestedRoles) {
        queue.push(row.GRANTED_ROLE);
      }
    }

    return false;
  }

  getEffectivePrivileges(username: string): {
    systemPrivileges: string[];
    roles: string[];
  } {
    const upperUsername = username.toUpperCase();
    const allPrivileges = new Set<string>();
    const allRoles = new Set<string>();

    // Get direct privileges
    const directPrivs = this.queryTable(
      `SELECT PRIVILEGE FROM SYSAUTH$ WHERE GRANTEE = '${upperUsername}'`
    );
    for (const row of directPrivs) {
      allPrivileges.add(row.PRIVILEGE);
    }

    // Collect roles and their privileges
    this.collectRolesAndPrivileges(upperUsername, allPrivileges, allRoles, new Set());

    return {
      systemPrivileges: [...allPrivileges].sort(),
      roles: [...allRoles].sort()
    };
  }

  private collectRolesAndPrivileges(
    grantee: string,
    privileges: Set<string>,
    roles: Set<string>,
    visited: Set<string>
  ): void {
    const grantedRoles = this.queryTable(
      `SELECT GRANTED_ROLE FROM ROLEAUTH$ WHERE GRANTEE = '${grantee}'`
    );

    for (const row of grantedRoles) {
      const roleName = row.GRANTED_ROLE;
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      roles.add(roleName);

      // Get privileges from this role
      const rolePrivs = this.queryTable(
        `SELECT PRIVILEGE FROM SYSAUTH$ WHERE GRANTEE = '${roleName}'`
      );
      for (const p of rolePrivs) {
        privileges.add(p.PRIVILEGE);
      }

      // Recurse
      this.collectRolesAndPrivileges(roleName, privileges, roles, visited);
    }
  }

  // ==========================================================================
  // Audit
  // ==========================================================================

  private auditAction(
    action: string,
    username: string,
    options?: {
      objectSchema?: string;
      objectName?: string;
      objectType?: string;
      sqlText?: string;
      returnCode?: number;
      sessionId?: number;
      comment?: string;
    }
  ): void {
    const auditId = this.auditSequence++;
    const now = new Date().toISOString();

    this.executeSQL(
      `INSERT INTO AUD$ (AUDIT_ID, SESSION_ID, EVENT_TIME, USERNAME, OS_USERNAME, TERMINAL, ACTION_NAME, OBJECT_SCHEMA, OBJECT_NAME, OBJECT_TYPE, SQL_TEXT, RETURN_CODE, COMMENT_TEXT) ` +
      `VALUES (${auditId}, ${options?.sessionId || 0}, '${now}', '${username}', 'unknown', 'SQLPLUS', '${action}', ${options?.objectSchema ? `'${options.objectSchema}'` : 'NULL'}, ${options?.objectName ? `'${options.objectName}'` : 'NULL'}, ${options?.objectType ? `'${options.objectType}'` : 'NULL'}, ${options?.sqlText ? `'${options.sqlText.replace(/'/g, "''")}'` : 'NULL'}, ${options?.returnCode || 0}, ${options?.comment ? `'${options.comment.replace(/'/g, "''")}'` : 'NULL'})`
    );
  }

  // ==========================================================================
  // Getters for Data Dictionary
  // ==========================================================================

  getUser(username: string): any | undefined {
    const rows = this.queryTable(`SELECT * FROM USER$ WHERE USERNAME = '${username.toUpperCase()}'`);
    return rows.length > 0 ? rows[0] : undefined;
  }

  getAllUsers(): any[] {
    return this.queryTable(`SELECT * FROM USER$ ORDER BY USERNAME`);
  }

  getRole(roleName: string): any | undefined {
    const rows = this.queryTable(`SELECT * FROM ROLE$ WHERE ROLE_NAME = '${roleName.toUpperCase()}'`);
    return rows.length > 0 ? rows[0] : undefined;
  }

  getAllRoles(): any[] {
    return this.queryTable(`SELECT * FROM ROLE$ ORDER BY ROLE_NAME`);
  }

  getProfile(profileName: string): any[] {
    return this.queryTable(`SELECT * FROM PROFILE$ WHERE PROFILE_NAME = '${profileName.toUpperCase()}'`);
  }

  getAllProfiles(): any[] {
    return this.queryTable(`SELECT DISTINCT PROFILE_NAME FROM PROFILE$ ORDER BY PROFILE_NAME`);
  }

  getAuditTrail(filter?: {
    username?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    objectName?: string;
  }): any[] {
    let sql = `SELECT * FROM AUD$ WHERE 1=1`;

    if (filter?.username) {
      sql += ` AND USERNAME = '${filter.username.toUpperCase()}'`;
    }
    if (filter?.action) {
      sql += ` AND ACTION_NAME = '${filter.action}'`;
    }
    if (filter?.objectName) {
      sql += ` AND OBJECT_NAME = '${filter.objectName.toUpperCase()}'`;
    }

    sql += ` ORDER BY EVENT_TIME DESC`;

    return this.queryTable(sql);
  }
}

// Note: Don't create singleton - each SQLPlus session creates its own with engine reference

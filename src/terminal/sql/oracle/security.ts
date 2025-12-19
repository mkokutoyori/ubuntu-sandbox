/**
 * Oracle Security Module
 *
 * Implements authentication, authorization, role-based access control (RBAC),
 * and audit capabilities similar to a real Oracle database.
 */

import { SQLResult, SQLRow, createSuccessResult, createErrorResult } from '../generic/types';
import { OracleUser, OracleProfile, OracleSystemPrivilege, OracleObjectPrivilege } from './types';

// ============================================================================
// Password Hashing (simulated SHA-256 style for Oracle)
// ============================================================================

/**
 * Simple hash function for password storage
 * In a real system, this would use proper cryptographic hashing
 */
export function hashPassword(password: string, salt?: string): string {
  const actualSalt = salt || generateSalt();
  let hash = 0;
  const combined = actualSalt + password;

  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Convert to hex and pad
  const hashHex = Math.abs(hash).toString(16).toUpperCase().padStart(16, '0');
  return `S:${hashHex}${actualSalt}`;
}

/**
 * Generate a random salt for password hashing
 */
export function generateSalt(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let salt = '';
  for (let i = 0; i < 20; i++) {
    salt += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return salt;
}

/**
 * Verify a password against a stored hash
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash.startsWith('S:')) {
    // Legacy plain text password (for backwards compatibility)
    return password === storedHash;
  }

  // Extract salt from stored hash (last 20 characters)
  const salt = storedHash.slice(-20);
  const expectedHash = hashPassword(password, salt);
  return expectedHash === storedHash;
}

// ============================================================================
// Role Definition
// ============================================================================

export interface OracleRole {
  name: string;
  password?: string;  // Optional password-protected role
  createdBy: string;
  createdDate: Date;
  grantedPrivileges: Set<string>;  // System privileges
  grantedObjectPrivileges: Map<string, Set<string>>;  // object -> privileges
  grantedRoles: Set<string>;  // Roles granted to this role
  isDefault: boolean;
}

// ============================================================================
// Audit Entry
// ============================================================================

export type AuditAction =
  | 'LOGON' | 'LOGOFF' | 'LOGON_FAILED'
  | 'CREATE_USER' | 'ALTER_USER' | 'DROP_USER'
  | 'CREATE_ROLE' | 'DROP_ROLE'
  | 'GRANT' | 'REVOKE'
  | 'CREATE_TABLE' | 'DROP_TABLE' | 'ALTER_TABLE' | 'TRUNCATE_TABLE'
  | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'
  | 'CREATE_SESSION' | 'ALTER_SESSION';

export interface AuditEntry {
  timestamp: Date;
  username: string;
  osUsername: string;
  terminal: string;
  action: AuditAction;
  objectOwner?: string;
  objectName?: string;
  objectType?: string;
  sqlText?: string;
  returnCode: number;  // 0 for success, error code for failure
  sessionId: number;
  clientIp?: string;
  comment?: string;
}

export interface AuditPolicy {
  action: AuditAction;
  objectOwner?: string;
  objectName?: string;
  byAccess: boolean;  // Audit each access vs once per session
  wheneverSuccessful: boolean;
  wheneverNotSuccessful: boolean;
}

// ============================================================================
// Oracle Security Manager
// ============================================================================

export class OracleSecurityManager {
  private users: Map<string, OracleUser> = new Map();
  private roles: Map<string, OracleRole> = new Map();
  private profiles: Map<string, OracleProfile> = new Map();
  private auditTrail: AuditEntry[] = [];
  private auditPolicies: AuditPolicy[] = [];
  private failedLoginAttempts: Map<string, number> = new Map();
  private currentSessionId: number = 1;

  constructor() {
    this.initializeDefaultProfiles();
    this.initializeBuiltinRoles();
    this.initializeSystemUsers();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  private initializeDefaultProfiles(): void {
    this.profiles.set('DEFAULT', {
      name: 'DEFAULT',
      sessionsPerUser: 'UNLIMITED',
      cpuPerSession: 'UNLIMITED',
      cpuPerCall: 'UNLIMITED',
      connectTime: 'UNLIMITED',
      idleTime: 'UNLIMITED',
      logicalReadsPerSession: 'UNLIMITED',
      logicalReadsPerCall: 'UNLIMITED',
      privateGA: 'UNLIMITED',
      compositeLimit: 'UNLIMITED',
      failedLoginAttempts: 10,
      passwordLifeTime: 180,  // days
      passwordReuseTime: 'UNLIMITED',
      passwordReuseMax: 'UNLIMITED',
      passwordLockTime: 1,  // days
      passwordGraceTime: 7,  // days
      passwordVerifyFunction: null
    });

    this.profiles.set('SECURE_PROFILE', {
      name: 'SECURE_PROFILE',
      sessionsPerUser: 3,
      cpuPerSession: 'UNLIMITED',
      cpuPerCall: 'UNLIMITED',
      connectTime: 480,  // 8 hours in minutes
      idleTime: 30,
      logicalReadsPerSession: 'UNLIMITED',
      logicalReadsPerCall: 'UNLIMITED',
      privateGA: 'UNLIMITED',
      compositeLimit: 'UNLIMITED',
      failedLoginAttempts: 3,
      passwordLifeTime: 60,
      passwordReuseTime: 365,
      passwordReuseMax: 10,
      passwordLockTime: 1,
      passwordGraceTime: 7,
      passwordVerifyFunction: 'ORA12C_VERIFY_FUNCTION'
    });
  }

  private initializeBuiltinRoles(): void {
    // CONNECT role - basic connection privileges
    this.roles.set('CONNECT', {
      name: 'CONNECT',
      createdBy: 'SYS',
      createdDate: new Date('2024-01-01'),
      grantedPrivileges: new Set(['CREATE SESSION']),
      grantedObjectPrivileges: new Map(),
      grantedRoles: new Set(),
      isDefault: true
    });

    // RESOURCE role - create objects
    this.roles.set('RESOURCE', {
      name: 'RESOURCE',
      createdBy: 'SYS',
      createdDate: new Date('2024-01-01'),
      grantedPrivileges: new Set([
        'CREATE TABLE',
        'CREATE SEQUENCE',
        'CREATE PROCEDURE',
        'CREATE TRIGGER'
      ]),
      grantedObjectPrivileges: new Map(),
      grantedRoles: new Set(),
      isDefault: true
    });

    // DBA role - full administrative privileges
    this.roles.set('DBA', {
      name: 'DBA',
      createdBy: 'SYS',
      createdDate: new Date('2024-01-01'),
      grantedPrivileges: new Set([
        'CREATE SESSION',
        'CREATE USER', 'ALTER USER', 'DROP USER',
        'CREATE ROLE', 'DROP ANY ROLE', 'GRANT ANY ROLE',
        'CREATE TABLE', 'CREATE ANY TABLE', 'ALTER ANY TABLE', 'DROP ANY TABLE',
        'SELECT ANY TABLE', 'INSERT ANY TABLE', 'UPDATE ANY TABLE', 'DELETE ANY TABLE',
        'CREATE VIEW', 'CREATE ANY VIEW', 'DROP ANY VIEW',
        'CREATE SEQUENCE', 'CREATE ANY SEQUENCE', 'DROP ANY SEQUENCE',
        'CREATE PROCEDURE', 'CREATE ANY PROCEDURE', 'DROP ANY PROCEDURE',
        'CREATE TABLESPACE', 'ALTER TABLESPACE', 'DROP TABLESPACE',
        'GRANT ANY PRIVILEGE', 'GRANT ANY OBJECT PRIVILEGE',
        'AUDIT ANY', 'ANALYZE ANY'
      ]),
      grantedObjectPrivileges: new Map(),
      grantedRoles: new Set(['CONNECT', 'RESOURCE']),
      isDefault: true
    });

    // SELECT_CATALOG_ROLE
    this.roles.set('SELECT_CATALOG_ROLE', {
      name: 'SELECT_CATALOG_ROLE',
      createdBy: 'SYS',
      createdDate: new Date('2024-01-01'),
      grantedPrivileges: new Set(),
      grantedObjectPrivileges: new Map(),
      grantedRoles: new Set(),
      isDefault: false
    });
  }

  private initializeSystemUsers(): void {
    // SYS user - superuser
    this.users.set('SYS', {
      username: 'SYS',
      password: hashPassword('oracle'),
      defaultTablespace: 'SYSTEM',
      temporaryTablespace: 'TEMP',
      profile: 'DEFAULT',
      accountStatus: 'OPEN',
      createdDate: new Date('2024-01-01'),
      quotas: new Map([['SYSTEM', 'UNLIMITED'], ['USERS', 'UNLIMITED']]),
      grantedRoles: ['DBA', 'SYSDBA'],
      grantedPrivileges: ['SYSDBA', 'SYSOPER']
    });

    // SYSTEM user - DBA
    this.users.set('SYSTEM', {
      username: 'SYSTEM',
      password: hashPassword('oracle'),
      defaultTablespace: 'SYSTEM',
      temporaryTablespace: 'TEMP',
      profile: 'DEFAULT',
      accountStatus: 'OPEN',
      createdDate: new Date('2024-01-01'),
      quotas: new Map([['SYSTEM', 'UNLIMITED'], ['USERS', 'UNLIMITED']]),
      grantedRoles: ['DBA'],
      grantedPrivileges: []
    });

    // SCOTT - classic demo user
    this.users.set('SCOTT', {
      username: 'SCOTT',
      password: hashPassword('tiger'),
      defaultTablespace: 'USERS',
      temporaryTablespace: 'TEMP',
      profile: 'DEFAULT',
      accountStatus: 'OPEN',
      createdDate: new Date('2024-01-01'),
      quotas: new Map([['USERS', 'UNLIMITED']]),
      grantedRoles: ['CONNECT', 'RESOURCE'],
      grantedPrivileges: []
    });
  }

  // ==========================================================================
  // Authentication
  // ==========================================================================

  /**
   * Authenticate a user with username and password
   */
  authenticate(username: string, password: string, options?: {
    osUser?: string;
    terminal?: string;
    clientIp?: string;
  }): { success: boolean; error?: string; sessionId?: number } {
    const upperUsername = username.toUpperCase();
    const user = this.users.get(upperUsername);

    // Check if user exists
    if (!user) {
      this.audit({
        action: 'LOGON_FAILED',
        username: upperUsername,
        osUsername: options?.osUser || 'unknown',
        terminal: options?.terminal || 'unknown',
        returnCode: 1017,  // ORA-01017: invalid username/password
        clientIp: options?.clientIp,
        comment: 'User does not exist'
      });
      return { success: false, error: 'ORA-01017: invalid username/password; logon denied' };
    }

    // Check account status
    if (user.accountStatus === 'LOCKED' || user.accountStatus === 'EXPIRED & LOCKED') {
      this.audit({
        action: 'LOGON_FAILED',
        username: upperUsername,
        osUsername: options?.osUser || 'unknown',
        terminal: options?.terminal || 'unknown',
        returnCode: 28000,  // ORA-28000: account is locked
        clientIp: options?.clientIp,
        comment: 'Account is locked'
      });
      return { success: false, error: 'ORA-28000: the account is locked' };
    }

    // Verify password
    if (!user.password || !verifyPassword(password, user.password)) {
      // Increment failed attempts
      const attempts = (this.failedLoginAttempts.get(upperUsername) || 0) + 1;
      this.failedLoginAttempts.set(upperUsername, attempts);

      // Check if we should lock the account
      const profile = this.profiles.get(user.profile) || this.profiles.get('DEFAULT')!;
      const maxAttempts = profile.failedLoginAttempts;

      if (maxAttempts !== 'UNLIMITED' && maxAttempts !== 'DEFAULT' && attempts >= maxAttempts) {
        user.accountStatus = 'LOCKED';
        user.lockDate = new Date();
        this.audit({
          action: 'LOGON_FAILED',
          username: upperUsername,
          osUsername: options?.osUser || 'unknown',
          terminal: options?.terminal || 'unknown',
          returnCode: 28000,
          clientIp: options?.clientIp,
          comment: `Account locked after ${attempts} failed attempts`
        });
        return { success: false, error: 'ORA-28000: the account is locked' };
      }

      this.audit({
        action: 'LOGON_FAILED',
        username: upperUsername,
        osUsername: options?.osUser || 'unknown',
        terminal: options?.terminal || 'unknown',
        returnCode: 1017,
        clientIp: options?.clientIp,
        comment: `Failed attempt ${attempts}`
      });
      return { success: false, error: 'ORA-01017: invalid username/password; logon denied' };
    }

    // Check password expiration
    if (user.accountStatus === 'EXPIRED') {
      this.audit({
        action: 'LOGON_FAILED',
        username: upperUsername,
        osUsername: options?.osUser || 'unknown',
        terminal: options?.terminal || 'unknown',
        returnCode: 28001,  // ORA-28001: password has expired
        clientIp: options?.clientIp,
        comment: 'Password expired'
      });
      return { success: false, error: 'ORA-28001: the password has expired' };
    }

    // Check if user has CREATE SESSION privilege
    if (!this.hasPrivilege(upperUsername, 'CREATE SESSION')) {
      this.audit({
        action: 'LOGON_FAILED',
        username: upperUsername,
        osUsername: options?.osUser || 'unknown',
        terminal: options?.terminal || 'unknown',
        returnCode: 1045,  // ORA-01045: user lacks CREATE SESSION privilege
        clientIp: options?.clientIp,
        comment: 'Lacks CREATE SESSION privilege'
      });
      return { success: false, error: 'ORA-01045: user lacks CREATE SESSION privilege; logon denied' };
    }

    // Successful login
    this.failedLoginAttempts.delete(upperUsername);
    user.lastLogin = new Date();
    const sessionId = this.currentSessionId++;

    this.audit({
      action: 'LOGON',
      username: upperUsername,
      osUsername: options?.osUser || 'unknown',
      terminal: options?.terminal || 'unknown',
      returnCode: 0,
      sessionId,
      clientIp: options?.clientIp
    });

    return { success: true, sessionId };
  }

  /**
   * End a session (logout)
   */
  logout(username: string, sessionId: number): void {
    this.audit({
      action: 'LOGOFF',
      username: username.toUpperCase(),
      osUsername: 'unknown',
      terminal: 'unknown',
      returnCode: 0,
      sessionId
    });
  }

  // ==========================================================================
  // User Management
  // ==========================================================================

  /**
   * Create a new user
   */
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
    if (this.users.has(upperUsername)) {
      return createErrorResult('USER_EXISTS', `ORA-01920: user name '${upperUsername}' conflicts with another user or role name`);
    }

    // Validate username
    if (!/^[A-Z][A-Z0-9_$#]*$/.test(upperUsername)) {
      return createErrorResult('INVALID_USERNAME', 'ORA-01935: missing user or role name');
    }

    // Create the user
    const user: OracleUser = {
      username: upperUsername,
      password: hashPassword(password),
      defaultTablespace: options?.defaultTablespace || 'USERS',
      temporaryTablespace: options?.temporaryTablespace || 'TEMP',
      profile: options?.profile || 'DEFAULT',
      accountStatus: options?.accountLocked ? 'LOCKED' : (options?.passwordExpire ? 'EXPIRED' : 'OPEN'),
      createdDate: new Date(),
      quotas: options?.quota || new Map([['USERS', 'UNLIMITED']]),
      grantedRoles: [],
      grantedPrivileges: []
    };

    if (options?.accountLocked) {
      user.lockDate = new Date();
    }

    this.users.set(upperUsername, user);

    // Audit
    this.audit({
      action: 'CREATE_USER',
      username: createdBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperUsername,
      objectType: 'USER',
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Alter an existing user
   */
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
      quota?: { tablespace: string; value: number | 'UNLIMITED' };
    },
    alteredBy?: string
  ): SQLResult {
    const upperUsername = username.toUpperCase();
    const user = this.users.get(upperUsername);

    if (!user) {
      return createErrorResult('USER_NOT_FOUND', `ORA-01918: user '${upperUsername}' does not exist`);
    }

    // Apply changes
    if (changes.password !== undefined) {
      user.password = hashPassword(changes.password);
      if (user.accountStatus === 'EXPIRED') {
        user.accountStatus = 'OPEN';
      }
    }

    if (changes.defaultTablespace !== undefined) {
      user.defaultTablespace = changes.defaultTablespace;
    }

    if (changes.temporaryTablespace !== undefined) {
      user.temporaryTablespace = changes.temporaryTablespace;
    }

    if (changes.profile !== undefined) {
      if (!this.profiles.has(changes.profile)) {
        return createErrorResult('PROFILE_NOT_FOUND', `ORA-02380: profile ${changes.profile} does not exist`);
      }
      user.profile = changes.profile;
    }

    if (changes.accountLock) {
      user.accountStatus = 'LOCKED';
      user.lockDate = new Date();
    }

    if (changes.accountUnlock) {
      if (user.accountStatus === 'LOCKED' || user.accountStatus === 'EXPIRED & LOCKED') {
        user.accountStatus = user.accountStatus === 'EXPIRED & LOCKED' ? 'EXPIRED' : 'OPEN';
        user.lockDate = undefined;
        this.failedLoginAttempts.delete(upperUsername);
      }
    }

    if (changes.passwordExpire) {
      user.accountStatus = user.accountStatus === 'LOCKED' ? 'EXPIRED & LOCKED' : 'EXPIRED';
      user.expiryDate = new Date();
    }

    if (changes.quota) {
      user.quotas.set(changes.quota.tablespace, changes.quota.value);
    }

    // Audit
    this.audit({
      action: 'ALTER_USER',
      username: alteredBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperUsername,
      objectType: 'USER',
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Drop a user
   */
  dropUser(username: string, cascade: boolean = false, droppedBy?: string): SQLResult {
    const upperUsername = username.toUpperCase();

    if (!this.users.has(upperUsername)) {
      return createErrorResult('USER_NOT_FOUND', `ORA-01918: user '${upperUsername}' does not exist`);
    }

    // Prevent dropping system users
    if (['SYS', 'SYSTEM', 'PUBLIC'].includes(upperUsername)) {
      return createErrorResult('CANNOT_DROP_USER', `ORA-01031: insufficient privileges to drop ${upperUsername}`);
    }

    this.users.delete(upperUsername);

    // Audit
    this.audit({
      action: 'DROP_USER',
      username: droppedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperUsername,
      objectType: 'USER',
      returnCode: 0
    });

    return createSuccessResult();
  }

  // ==========================================================================
  // Role Management
  // ==========================================================================

  /**
   * Create a new role
   */
  createRole(roleName: string, password?: string, createdBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();

    if (this.roles.has(upperRoleName)) {
      return createErrorResult('ROLE_EXISTS', `ORA-01921: role name '${upperRoleName}' conflicts with another user or role name`);
    }

    if (this.users.has(upperRoleName)) {
      return createErrorResult('NAME_CONFLICT', `ORA-01921: role name '${upperRoleName}' conflicts with another user or role name`);
    }

    this.roles.set(upperRoleName, {
      name: upperRoleName,
      password: password ? hashPassword(password) : undefined,
      createdBy: createdBy || 'SYSTEM',
      createdDate: new Date(),
      grantedPrivileges: new Set(),
      grantedObjectPrivileges: new Map(),
      grantedRoles: new Set(),
      isDefault: false
    });

    this.audit({
      action: 'CREATE_ROLE',
      username: createdBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperRoleName,
      objectType: 'ROLE',
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Drop a role
   */
  dropRole(roleName: string, droppedBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();

    if (!this.roles.has(upperRoleName)) {
      return createErrorResult('ROLE_NOT_FOUND', `ORA-01919: role '${upperRoleName}' does not exist`);
    }

    // Prevent dropping built-in roles
    const role = this.roles.get(upperRoleName)!;
    if (role.createdBy === 'SYS' && ['CONNECT', 'RESOURCE', 'DBA'].includes(upperRoleName)) {
      return createErrorResult('CANNOT_DROP_ROLE', `ORA-01031: insufficient privileges to drop built-in role ${upperRoleName}`);
    }

    // Remove role from all users
    for (const user of this.users.values()) {
      const idx = user.grantedRoles.indexOf(upperRoleName);
      if (idx > -1) {
        user.grantedRoles.splice(idx, 1);
      }
    }

    // Remove role from all other roles
    for (const otherRole of this.roles.values()) {
      otherRole.grantedRoles.delete(upperRoleName);
    }

    this.roles.delete(upperRoleName);

    this.audit({
      action: 'DROP_ROLE',
      username: droppedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperRoleName,
      objectType: 'ROLE',
      returnCode: 0
    });

    return createSuccessResult();
  }

  // ==========================================================================
  // Privilege Management
  // ==========================================================================

  /**
   * Grant a system privilege to a user or role
   */
  grantSystemPrivilege(
    privilege: string,
    grantee: string,
    withAdminOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    // Check if grantee is a user or role
    const user = this.users.get(upperGrantee);
    const role = this.roles.get(upperGrantee);

    if (!user && !role) {
      return createErrorResult('GRANTEE_NOT_FOUND', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    if (user) {
      if (!user.grantedPrivileges.includes(upperPrivilege)) {
        user.grantedPrivileges.push(upperPrivilege);
      }
    } else if (role) {
      role.grantedPrivileges.add(upperPrivilege);
    }

    this.audit({
      action: 'GRANT',
      username: grantedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperPrivilege,
      objectType: 'SYSTEM PRIVILEGE',
      comment: `Granted to ${upperGrantee}`,
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Grant an object privilege to a user or role
   */
  grantObjectPrivilege(
    privilege: string,
    objectOwner: string,
    objectName: string,
    grantee: string,
    withGrantOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();
    const fullObjectName = `${objectOwner.toUpperCase()}.${objectName.toUpperCase()}`;

    const user = this.users.get(upperGrantee);
    const role = this.roles.get(upperGrantee);

    if (!user && !role) {
      return createErrorResult('GRANTEE_NOT_FOUND', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    if (role) {
      if (!role.grantedObjectPrivileges.has(fullObjectName)) {
        role.grantedObjectPrivileges.set(fullObjectName, new Set());
      }
      role.grantedObjectPrivileges.get(fullObjectName)!.add(upperPrivilege);
    }

    this.audit({
      action: 'GRANT',
      username: grantedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectOwner: objectOwner.toUpperCase(),
      objectName: objectName.toUpperCase(),
      objectType: 'OBJECT PRIVILEGE',
      comment: `${upperPrivilege} granted to ${upperGrantee}`,
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Grant a role to a user or another role
   */
  grantRole(
    roleName: string,
    grantee: string,
    withAdminOption: boolean = false,
    grantedBy?: string
  ): SQLResult {
    const upperRoleName = roleName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const roleToGrant = this.roles.get(upperRoleName);
    if (!roleToGrant) {
      return createErrorResult('ROLE_NOT_FOUND', `ORA-01919: role '${upperRoleName}' does not exist`);
    }

    const user = this.users.get(upperGrantee);
    const targetRole = this.roles.get(upperGrantee);

    if (!user && !targetRole) {
      return createErrorResult('GRANTEE_NOT_FOUND', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    if (user) {
      if (!user.grantedRoles.includes(upperRoleName)) {
        user.grantedRoles.push(upperRoleName);
      }
    } else if (targetRole) {
      // Check for circular grant
      if (this.wouldCreateCircularGrant(upperRoleName, upperGrantee)) {
        return createErrorResult('CIRCULAR_GRANT', `ORA-01934: circular role grant detected`);
      }
      targetRole.grantedRoles.add(upperRoleName);
    }

    this.audit({
      action: 'GRANT',
      username: grantedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperRoleName,
      objectType: 'ROLE',
      comment: `Granted to ${upperGrantee}`,
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Revoke a system privilege from a user or role
   */
  revokeSystemPrivilege(privilege: string, grantee: string, revokedBy?: string): SQLResult {
    const upperPrivilege = privilege.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const user = this.users.get(upperGrantee);
    const role = this.roles.get(upperGrantee);

    if (!user && !role) {
      return createErrorResult('GRANTEE_NOT_FOUND', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    if (user) {
      const idx = user.grantedPrivileges.indexOf(upperPrivilege);
      if (idx > -1) {
        user.grantedPrivileges.splice(idx, 1);
      }
    } else if (role) {
      role.grantedPrivileges.delete(upperPrivilege);
    }

    this.audit({
      action: 'REVOKE',
      username: revokedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperPrivilege,
      objectType: 'SYSTEM PRIVILEGE',
      comment: `Revoked from ${upperGrantee}`,
      returnCode: 0
    });

    return createSuccessResult();
  }

  /**
   * Revoke a role from a user or another role
   */
  revokeRole(roleName: string, grantee: string, revokedBy?: string): SQLResult {
    const upperRoleName = roleName.toUpperCase();
    const upperGrantee = grantee.toUpperCase();

    const user = this.users.get(upperGrantee);
    const targetRole = this.roles.get(upperGrantee);

    if (!user && !targetRole) {
      return createErrorResult('GRANTEE_NOT_FOUND', `ORA-01917: user or role '${upperGrantee}' does not exist`);
    }

    if (user) {
      const idx = user.grantedRoles.indexOf(upperRoleName);
      if (idx > -1) {
        user.grantedRoles.splice(idx, 1);
      }
    } else if (targetRole) {
      targetRole.grantedRoles.delete(upperRoleName);
    }

    this.audit({
      action: 'REVOKE',
      username: revokedBy || 'SYSTEM',
      osUsername: 'unknown',
      terminal: 'unknown',
      objectName: upperRoleName,
      objectType: 'ROLE',
      comment: `Revoked from ${upperGrantee}`,
      returnCode: 0
    });

    return createSuccessResult();
  }

  // ==========================================================================
  // Privilege Checking
  // ==========================================================================

  /**
   * Check if a user has a specific system privilege
   */
  hasPrivilege(username: string, privilege: string): boolean {
    const upperUsername = username.toUpperCase();
    const upperPrivilege = privilege.toUpperCase();
    const user = this.users.get(upperUsername);

    if (!user) return false;

    // SYS and users with SYSDBA have all privileges
    if (upperUsername === 'SYS' || user.grantedPrivileges.includes('SYSDBA')) {
      return true;
    }

    // Direct privilege
    if (user.grantedPrivileges.includes(upperPrivilege)) {
      return true;
    }

    // Check privileges from roles (recursively)
    return this.hasPrivilegeFromRoles(user.grantedRoles, upperPrivilege, new Set());
  }

  private hasPrivilegeFromRoles(roleNames: string[], privilege: string, visited: Set<string>): boolean {
    for (const roleName of roleNames) {
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      const role = this.roles.get(roleName);
      if (!role) continue;

      if (role.grantedPrivileges.has(privilege)) {
        return true;
      }

      // Check nested roles
      if (this.hasPrivilegeFromRoles([...role.grantedRoles], privilege, visited)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a user has a specific object privilege
   */
  hasObjectPrivilege(
    username: string,
    privilege: string,
    objectOwner: string,
    objectName: string
  ): boolean {
    const upperUsername = username.toUpperCase();
    const upperPrivilege = privilege.toUpperCase();
    const user = this.users.get(upperUsername);

    if (!user) return false;

    // Object owner has all privileges on their objects
    if (upperUsername === objectOwner.toUpperCase()) {
      return true;
    }

    // SYS has all privileges
    if (upperUsername === 'SYS') {
      return true;
    }

    // Check for ANY privilege (e.g., SELECT ANY TABLE)
    const anyPrivilege = `${upperPrivilege} ANY TABLE`;
    if (this.hasPrivilege(upperUsername, anyPrivilege)) {
      return true;
    }

    // Check object privileges from roles
    const fullObjectName = `${objectOwner.toUpperCase()}.${objectName.toUpperCase()}`;
    return this.hasObjectPrivilegeFromRoles(user.grantedRoles, upperPrivilege, fullObjectName, new Set());
  }

  private hasObjectPrivilegeFromRoles(
    roleNames: string[],
    privilege: string,
    fullObjectName: string,
    visited: Set<string>
  ): boolean {
    for (const roleName of roleNames) {
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      const role = this.roles.get(roleName);
      if (!role) continue;

      const objPrivs = role.grantedObjectPrivileges.get(fullObjectName);
      if (objPrivs && (objPrivs.has(privilege) || objPrivs.has('ALL') || objPrivs.has('ALL PRIVILEGES'))) {
        return true;
      }

      if (this.hasObjectPrivilegeFromRoles([...role.grantedRoles], privilege, fullObjectName, visited)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get all effective privileges for a user
   */
  getEffectivePrivileges(username: string): {
    systemPrivileges: string[];
    roles: string[];
  } {
    const upperUsername = username.toUpperCase();
    const user = this.users.get(upperUsername);

    if (!user) {
      return { systemPrivileges: [], roles: [] };
    }

    const allPrivileges = new Set<string>(user.grantedPrivileges);
    const allRoles = new Set<string>();

    // Collect all roles and their privileges recursively
    this.collectRolesAndPrivileges(user.grantedRoles, allPrivileges, allRoles, new Set());

    return {
      systemPrivileges: [...allPrivileges].sort(),
      roles: [...allRoles].sort()
    };
  }

  private collectRolesAndPrivileges(
    roleNames: string[],
    privileges: Set<string>,
    roles: Set<string>,
    visited: Set<string>
  ): void {
    for (const roleName of roleNames) {
      if (visited.has(roleName)) continue;
      visited.add(roleName);

      roles.add(roleName);
      const role = this.roles.get(roleName);
      if (!role) continue;

      for (const priv of role.grantedPrivileges) {
        privileges.add(priv);
      }

      this.collectRolesAndPrivileges([...role.grantedRoles], privileges, roles, visited);
    }
  }

  private wouldCreateCircularGrant(roleName: string, targetRole: string): boolean {
    if (roleName === targetRole) return true;

    const role = this.roles.get(roleName);
    if (!role) return false;

    const visited = new Set<string>();
    const queue = [...role.grantedRoles];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === targetRole) return true;
      if (visited.has(current)) continue;
      visited.add(current);

      const currentRole = this.roles.get(current);
      if (currentRole) {
        queue.push(...currentRole.grantedRoles);
      }
    }

    return false;
  }

  // ==========================================================================
  // Audit
  // ==========================================================================

  private audit(entry: Omit<AuditEntry, 'timestamp' | 'sessionId'> & { sessionId?: number }): void {
    this.auditTrail.push({
      ...entry,
      timestamp: new Date(),
      sessionId: entry.sessionId || 0
    });

    // Keep only last 10000 entries
    if (this.auditTrail.length > 10000) {
      this.auditTrail = this.auditTrail.slice(-10000);
    }
  }

  /**
   * Add an audit policy
   */
  addAuditPolicy(policy: AuditPolicy): void {
    this.auditPolicies.push(policy);
  }

  /**
   * Remove an audit policy
   */
  removeAuditPolicy(action: AuditAction, objectName?: string): void {
    this.auditPolicies = this.auditPolicies.filter(p =>
      !(p.action === action && p.objectName === objectName)
    );
  }

  /**
   * Record an auditable action
   */
  auditAction(
    action: AuditAction,
    username: string,
    options: {
      objectOwner?: string;
      objectName?: string;
      objectType?: string;
      sqlText?: string;
      returnCode?: number;
      sessionId?: number;
    }
  ): void {
    // Check if this action should be audited
    const shouldAudit = this.auditPolicies.some(policy => {
      if (policy.action !== action) return false;
      if (policy.objectName && policy.objectName !== options.objectName) return false;
      if (policy.objectOwner && policy.objectOwner !== options.objectOwner) return false;

      const isSuccess = (options.returnCode || 0) === 0;
      if (isSuccess && !policy.wheneverSuccessful) return false;
      if (!isSuccess && !policy.wheneverNotSuccessful) return false;

      return true;
    });

    if (shouldAudit) {
      this.audit({
        action,
        username: username.toUpperCase(),
        osUsername: 'unknown',
        terminal: 'unknown',
        ...options,
        returnCode: options.returnCode || 0
      });
    }
  }

  /**
   * Get audit trail
   */
  getAuditTrail(filter?: {
    username?: string;
    action?: AuditAction;
    startDate?: Date;
    endDate?: Date;
    objectName?: string;
  }): AuditEntry[] {
    let entries = [...this.auditTrail];

    if (filter) {
      if (filter.username) {
        entries = entries.filter(e => e.username === filter.username.toUpperCase());
      }
      if (filter.action) {
        entries = entries.filter(e => e.action === filter.action);
      }
      if (filter.startDate) {
        entries = entries.filter(e => e.timestamp >= filter.startDate!);
      }
      if (filter.endDate) {
        entries = entries.filter(e => e.timestamp <= filter.endDate!);
      }
      if (filter.objectName) {
        entries = entries.filter(e => e.objectName === filter.objectName!.toUpperCase());
      }
    }

    return entries;
  }

  // ==========================================================================
  // Getters for Data Dictionary Views
  // ==========================================================================

  getUser(username: string): OracleUser | undefined {
    return this.users.get(username.toUpperCase());
  }

  getAllUsers(): OracleUser[] {
    return [...this.users.values()];
  }

  getRole(roleName: string): OracleRole | undefined {
    return this.roles.get(roleName.toUpperCase());
  }

  getAllRoles(): OracleRole[] {
    return [...this.roles.values()];
  }

  getProfile(profileName: string): OracleProfile | undefined {
    return this.profiles.get(profileName.toUpperCase());
  }

  getAllProfiles(): OracleProfile[] {
    return [...this.profiles.values()];
  }
}

// Singleton instance
export const oracleSecurityManager = new OracleSecurityManager();

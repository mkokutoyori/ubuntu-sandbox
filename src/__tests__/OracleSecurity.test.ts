/**
 * Oracle Security Module Tests - SQL-based implementation
 *
 * Tests for authentication, authorization, RBAC, and audit
 * All security data is stored in SQL tables (SYS.USER$, SYS.ROLE$, etc.)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SQLEngine } from '../terminal/sql/generic/engine';
import {
  OracleSecurityManager,
  hashPassword,
  verifyPassword,
  generateSalt
} from '../terminal/sql/oracle/security';
import { createSQLPlusSession, executeSQLPlus } from '../terminal/sql/oracle/sqlplus';

describe('Oracle Security Module', () => {
  describe('Password Hashing', () => {
    it('should generate unique salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      expect(salt1).not.toBe(salt2);
      expect(salt1.length).toBe(20);
      expect(salt2.length).toBe(20);
    });

    it('should hash passwords with salt', () => {
      const password = 'secret123';
      const hash = hashPassword(password);
      expect(hash).toMatch(/^S:[0-9A-F]{16}[A-Z0-9]{20}$/);
    });

    it('should verify correct password', () => {
      const password = 'mypassword';
      const hash = hashPassword(password);
      expect(verifyPassword(password, hash)).toBe(true);
    });

    it('should reject incorrect password', () => {
      const password = 'mypassword';
      const hash = hashPassword(password);
      expect(verifyPassword('wrongpassword', hash)).toBe(false);
    });

    it('should handle legacy plain text passwords', () => {
      expect(verifyPassword('plaintext', 'plaintext')).toBe(true);
      expect(verifyPassword('plaintext', 'different')).toBe(false);
    });
  });

  describe('OracleSecurityManager with SQL Tables', () => {
    let engine: SQLEngine;
    let secMgr: OracleSecurityManager;

    beforeEach(() => {
      engine = new SQLEngine({
        caseSensitiveIdentifiers: false,
        defaultSchema: 'SYSTEM',
        autoCommit: true
      });
      engine.createSchema('SYSTEM');
      engine.setCurrentSchema('SYSTEM');
      secMgr = new OracleSecurityManager(engine);
    });

    describe('Security Tables Created', () => {
      it('should create SYS.USER$ table', () => {
        engine.setCurrentSchema('SYS');
        const tables = engine.listTables();
        expect(tables).toContain('USER$');
      });

      it('should create SYS.ROLE$ table', () => {
        engine.setCurrentSchema('SYS');
        const tables = engine.listTables();
        expect(tables).toContain('ROLE$');
      });

      it('should create SYS.SYSAUTH$ table', () => {
        engine.setCurrentSchema('SYS');
        const tables = engine.listTables();
        expect(tables).toContain('SYSAUTH$');
      });

      it('should create SYS.AUD$ table for audit', () => {
        engine.setCurrentSchema('SYS');
        const tables = engine.listTables();
        expect(tables).toContain('AUD$');
      });
    });

    describe('Built-in Users and Roles', () => {
      it('should have SYS user with DBA role', () => {
        const sys = secMgr.getUser('SYS');
        expect(sys).toBeDefined();
        expect(sys!.ACCOUNT_STATUS).toBe('OPEN');
      });

      it('should have SYSTEM user', () => {
        const system = secMgr.getUser('SYSTEM');
        expect(system).toBeDefined();
      });

      it('should have SCOTT demo user', () => {
        const scott = secMgr.getUser('SCOTT');
        expect(scott).toBeDefined();
      });

      it('should have built-in roles CONNECT, RESOURCE, DBA', () => {
        expect(secMgr.getRole('CONNECT')).toBeDefined();
        expect(secMgr.getRole('RESOURCE')).toBeDefined();
        expect(secMgr.getRole('DBA')).toBeDefined();
      });

      it('should have DEFAULT profile in PROFILE$ table', () => {
        const profile = secMgr.getProfile('DEFAULT');
        expect(profile.length).toBeGreaterThan(0);
      });
    });

    describe('Authentication', () => {
      it('should authenticate valid user with correct password', () => {
        const result = secMgr.authenticate('SCOTT', 'tiger');
        expect(result.success).toBe(true);
        expect(result.sessionId).toBeGreaterThan(0);
      });

      it('should reject invalid username', () => {
        const result = secMgr.authenticate('NONEXISTENT', 'password');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ORA-01017');
      });

      it('should reject wrong password', () => {
        const result = secMgr.authenticate('SCOTT', 'wrongpassword');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ORA-01017');
      });

      it('should lock account after max failed attempts', () => {
        // Create a user with SECURE_PROFILE (3 failed attempts max)
        secMgr.createUser('TESTUSER', 'testpass', { profile: 'SECURE_PROFILE' });
        secMgr.grantRole('CONNECT', 'TESTUSER');

        // Fail 3 times
        secMgr.authenticate('TESTUSER', 'wrong1');
        secMgr.authenticate('TESTUSER', 'wrong2');
        const result = secMgr.authenticate('TESTUSER', 'wrong3');

        expect(result.success).toBe(false);
        expect(result.error).toContain('ORA-28000');

        const user = secMgr.getUser('TESTUSER');
        expect(user!.ACCOUNT_STATUS).toBe('LOCKED');
      });

      it('should reject locked account', () => {
        secMgr.createUser('LOCKEDUSER', 'password', { accountLocked: true });
        secMgr.grantRole('CONNECT', 'LOCKEDUSER');

        const result = secMgr.authenticate('LOCKEDUSER', 'password');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ORA-28000');
      });

      it('should reject expired password', () => {
        secMgr.createUser('EXPIREDUSER', 'password', { passwordExpire: true });
        secMgr.grantRole('CONNECT', 'EXPIREDUSER');

        const result = secMgr.authenticate('EXPIREDUSER', 'password');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ORA-28001');
      });

      it('should reject user without CREATE SESSION privilege', () => {
        secMgr.createUser('NOLOGIN', 'password');
        // Don't grant CONNECT role

        const result = secMgr.authenticate('NOLOGIN', 'password');
        expect(result.success).toBe(false);
        expect(result.error).toContain('ORA-01045');
      });
    });

    describe('User Management via SQL', () => {
      it('should create a new user in USER$ table', () => {
        const result = secMgr.createUser('NEWUSER', 'password123');
        expect(result.success).toBe(true);

        const user = secMgr.getUser('NEWUSER');
        expect(user).toBeDefined();
        expect(user!.USERNAME).toBe('NEWUSER');
        expect(user!.USER_PROFILE).toBe('DEFAULT');
        expect(user!.ACCOUNT_STATUS).toBe('OPEN');
      });

      it('should reject duplicate username', () => {
        secMgr.createUser('DUPUSER', 'pass1');
        const result = secMgr.createUser('DUPUSER', 'pass2');
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('ORA-01920');
      });

      it('should create user with custom options', () => {
        secMgr.createUser('CUSTOMUSER', 'password', {
          defaultTablespace: 'USERS',
          temporaryTablespace: 'TEMP',
          profile: 'SECURE_PROFILE',
          accountLocked: true
        });

        const user = secMgr.getUser('CUSTOMUSER');
        expect(user!.USER_PROFILE).toBe('SECURE_PROFILE');
        expect(user!.ACCOUNT_STATUS).toBe('LOCKED');
      });

      it('should alter user password', () => {
        secMgr.createUser('ALTERTEST', 'oldpassword');
        secMgr.grantRole('CONNECT', 'ALTERTEST');

        secMgr.alterUser('ALTERTEST', { password: 'newpassword' });

        const result = secMgr.authenticate('ALTERTEST', 'newpassword');
        expect(result.success).toBe(true);
      });

      it('should lock and unlock user account', () => {
        secMgr.createUser('LOCKTEST', 'password');

        secMgr.alterUser('LOCKTEST', { accountLock: true });
        expect(secMgr.getUser('LOCKTEST')!.ACCOUNT_STATUS).toBe('LOCKED');

        secMgr.alterUser('LOCKTEST', { accountUnlock: true });
        expect(secMgr.getUser('LOCKTEST')!.ACCOUNT_STATUS).toBe('OPEN');
      });

      it('should drop user and remove from USER$ table', () => {
        secMgr.createUser('DROPME', 'password');
        expect(secMgr.getUser('DROPME')).toBeDefined();

        const result = secMgr.dropUser('DROPME');
        expect(result.success).toBe(true);
        expect(secMgr.getUser('DROPME')).toBeUndefined();
      });

      it('should not allow dropping SYS or SYSTEM', () => {
        const result1 = secMgr.dropUser('SYS');
        const result2 = secMgr.dropUser('SYSTEM');

        expect(result1.success).toBe(false);
        expect(result2.success).toBe(false);
      });
    });

    describe('Role Management via SQL', () => {
      it('should create a new role in ROLE$ table', () => {
        const result = secMgr.createRole('MYROLE');
        expect(result.success).toBe(true);
        expect(secMgr.getRole('MYROLE')).toBeDefined();
      });

      it('should reject duplicate role name', () => {
        secMgr.createRole('DUPROLE');
        const result = secMgr.createRole('DUPROLE');
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain('ORA-01921');
      });

      it('should reject role name conflicting with user', () => {
        secMgr.createUser('CONFLICTNAME', 'pass');
        const result = secMgr.createRole('CONFLICTNAME');
        expect(result.success).toBe(false);
      });

      it('should grant role to user and update ROLEAUTH$ table', () => {
        secMgr.createRole('TESTROLE');
        secMgr.createUser('ROLEUSER', 'pass');

        const result = secMgr.grantRole('TESTROLE', 'ROLEUSER');
        expect(result.success).toBe(true);

        // Verify via hasPrivilege which queries ROLEAUTH$
        const effective = secMgr.getEffectivePrivileges('ROLEUSER');
        expect(effective.roles).toContain('TESTROLE');
      });

      it('should revoke role from user', () => {
        secMgr.createRole('REVOKEROLE');
        secMgr.createUser('REVOKEUSER', 'pass');
        secMgr.grantRole('REVOKEROLE', 'REVOKEUSER');

        const result = secMgr.revokeRole('REVOKEROLE', 'REVOKEUSER');
        expect(result.success).toBe(true);

        const effective = secMgr.getEffectivePrivileges('REVOKEUSER');
        expect(effective.roles).not.toContain('REVOKEROLE');
      });

      it('should drop role and remove from all users', () => {
        secMgr.createRole('DROPROLE');
        secMgr.createUser('USER1', 'pass');
        secMgr.createUser('USER2', 'pass');
        secMgr.grantRole('DROPROLE', 'USER1');
        secMgr.grantRole('DROPROLE', 'USER2');

        secMgr.dropRole('DROPROLE');

        expect(secMgr.getEffectivePrivileges('USER1').roles).not.toContain('DROPROLE');
        expect(secMgr.getEffectivePrivileges('USER2').roles).not.toContain('DROPROLE');
      });

      it('should not allow dropping built-in roles', () => {
        const result = secMgr.dropRole('DBA');
        expect(result.success).toBe(false);
      });
    });

    describe('Privilege Management via SYSAUTH$ table', () => {
      it('should grant system privilege', () => {
        secMgr.createUser('PRIVUSER', 'pass');

        const result = secMgr.grantSystemPrivilege('CREATE TABLE', 'PRIVUSER');
        expect(result.success).toBe(true);

        const effective = secMgr.getEffectivePrivileges('PRIVUSER');
        expect(effective.systemPrivileges).toContain('CREATE TABLE');
      });

      it('should revoke system privilege', () => {
        secMgr.createUser('PRIVUSER2', 'pass');
        secMgr.grantSystemPrivilege('CREATE TABLE', 'PRIVUSER2');

        const result = secMgr.revokeSystemPrivilege('CREATE TABLE', 'PRIVUSER2');
        expect(result.success).toBe(true);

        const effective = secMgr.getEffectivePrivileges('PRIVUSER2');
        expect(effective.systemPrivileges).not.toContain('CREATE TABLE');
      });

      it('should grant privilege to role', () => {
        secMgr.createRole('ROLEPRIV');

        secMgr.grantSystemPrivilege('CREATE VIEW', 'ROLEPRIV');

        // User with this role should have the privilege
        secMgr.createUser('ROLEUSER', 'pass');
        secMgr.grantRole('ROLEPRIV', 'ROLEUSER');

        expect(secMgr.hasPrivilege('ROLEUSER', 'CREATE VIEW')).toBe(true);
      });
    });

    describe('Privilege Checking via SQL queries', () => {
      it('should check direct privilege from SYSAUTH$', () => {
        secMgr.createUser('DIRECTPRIV', 'pass');
        secMgr.grantSystemPrivilege('CREATE TABLE', 'DIRECTPRIV');

        expect(secMgr.hasPrivilege('DIRECTPRIV', 'CREATE TABLE')).toBe(true);
        expect(secMgr.hasPrivilege('DIRECTPRIV', 'DROP TABLE')).toBe(false);
      });

      it('should check privilege from role via ROLEAUTH$ join', () => {
        secMgr.createUser('ROLEPRIV', 'pass');
        secMgr.grantRole('RESOURCE', 'ROLEPRIV');

        expect(secMgr.hasPrivilege('ROLEPRIV', 'CREATE TABLE')).toBe(true);
        expect(secMgr.hasPrivilege('ROLEPRIV', 'CREATE SEQUENCE')).toBe(true);
      });

      it('should check nested role privileges', () => {
        secMgr.createRole('INNERROLE');
        secMgr.grantSystemPrivilege('CREATE SYNONYM', 'INNERROLE');

        secMgr.createRole('OUTERROLE');
        secMgr.grantRole('INNERROLE', 'OUTERROLE');

        secMgr.createUser('NESTEDUSER', 'pass');
        secMgr.grantRole('OUTERROLE', 'NESTEDUSER');

        expect(secMgr.hasPrivilege('NESTEDUSER', 'CREATE SYNONYM')).toBe(true);
      });

      it('should return all privileges for SYS', () => {
        expect(secMgr.hasPrivilege('SYS', 'ANY_PRIVILEGE_AT_ALL')).toBe(true);
      });

      it('should get effective privileges by querying tables', () => {
        secMgr.createUser('EFFPRIV', 'pass');
        secMgr.grantSystemPrivilege('CREATE TABLE', 'EFFPRIV');
        secMgr.grantRole('CONNECT', 'EFFPRIV');

        const effective = secMgr.getEffectivePrivileges('EFFPRIV');
        expect(effective.systemPrivileges).toContain('CREATE TABLE');
        expect(effective.systemPrivileges).toContain('CREATE SESSION');
        expect(effective.roles).toContain('CONNECT');
      });
    });

    describe('Audit Trail in AUD$ table', () => {
      it('should audit successful login to AUD$ table', () => {
        secMgr.authenticate('SCOTT', 'tiger');

        const trail = secMgr.getAuditTrail({ username: 'SCOTT', action: 'LOGON' });
        expect(trail.length).toBeGreaterThan(0);
        expect(trail[0].RETURN_CODE).toBe(0);
      });

      it('should audit failed login to AUD$ table', () => {
        secMgr.authenticate('SCOTT', 'wrongpassword');

        const trail = secMgr.getAuditTrail({ username: 'SCOTT', action: 'LOGON_FAILED' });
        expect(trail.length).toBeGreaterThan(0);
        expect(trail[0].RETURN_CODE).not.toBe(0);
      });

      it('should audit user creation to AUD$ table', () => {
        secMgr.createUser('AUDITUSER', 'pass', undefined, 'SYSTEM');

        const trail = secMgr.getAuditTrail({ action: 'CREATE_USER', objectName: 'AUDITUSER' });
        expect(trail.length).toBe(1);
        expect(trail[0].USERNAME).toBe('SYSTEM');
      });

      it('should be queryable via SQL', () => {
        // Create some audit events
        secMgr.createUser('A1', 'pass', undefined, 'SYSTEM');
        secMgr.createUser('A2', 'pass', undefined, 'SYSTEM');
        secMgr.createRole('R1', undefined, 'SYSTEM');

        // Query audit trail
        const userTrail = secMgr.getAuditTrail({ action: 'CREATE_USER' });
        const roleTrail = secMgr.getAuditTrail({ action: 'CREATE_ROLE' });

        expect(userTrail.length).toBeGreaterThanOrEqual(2);
        expect(roleTrail.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('SQLPlus Integration with SQL-based Security', () => {
    it('should create session with security manager that uses SQL tables', () => {
      const session = createSQLPlusSession();
      expect(session.securityManager).toBeDefined();
      expect(session.username).toBe('SYSTEM');

      // Verify security tables exist
      session.engine.setCurrentSchema('SYS');
      const tables = session.engine.listTables();
      expect(tables).toContain('USER$');
      expect(tables).toContain('ROLE$');
      expect(tables).toContain('AUD$');
    });

    it('should authenticate valid user on CONNECT', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'connect scott/tiger');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Connected');
      expect(session.username).toBe('SCOTT');
    });

    it('should reject invalid password on CONNECT', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'connect scott/wrongpass');
      expect(result.error).toContain('ORA-01017');
      expect(session.connected).toBe(false);
    });

    it('should reject non-existent user on CONNECT', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'connect nobody/anypass');
      expect(result.error).toContain('ORA-01017');
    });

    it('should execute CREATE USER and store in USER$ table', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'CREATE USER testuser IDENTIFIED BY password123;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('created');

      // Verify user exists in USER$ table
      const user = session.securityManager.getUser('TESTUSER');
      expect(user).toBeDefined();
    });

    it('should execute ALTER USER', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER altertest IDENTIFIED BY oldpass;');
      const result = executeSQLPlus(session, 'ALTER USER altertest IDENTIFIED BY newpass;');
      expect(result.error).toBeUndefined();
    });

    it('should execute DROP USER and remove from USER$ table', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER droptest IDENTIFIED BY pass;');
      const result = executeSQLPlus(session, 'DROP USER droptest;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('dropped');

      // Verify user removed from USER$ table
      const user = session.securityManager.getUser('DROPTEST');
      expect(user).toBeUndefined();
    });

    it('should execute GRANT role and update ROLEAUTH$ table', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER granttest IDENTIFIED BY pass;');
      const result = executeSQLPlus(session, 'GRANT CONNECT TO granttest;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('succeeded');

      // Verify role granted via security manager query
      const effective = session.securityManager.getEffectivePrivileges('GRANTTEST');
      expect(effective.roles).toContain('CONNECT');
    });

    it('should execute REVOKE role and update ROLEAUTH$ table', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER revoketest IDENTIFIED BY pass;');
      executeSQLPlus(session, 'GRANT CONNECT TO revoketest;');
      const result = executeSQLPlus(session, 'REVOKE CONNECT FROM revoketest;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('succeeded');

      // Verify role revoked
      const effective = session.securityManager.getEffectivePrivileges('REVOKETEST');
      expect(effective.roles).not.toContain('CONNECT');
    });

    it('should execute CREATE ROLE and store in ROLE$ table', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'CREATE ROLE myrole;');
      expect(result.error).toBeUndefined();

      // Verify role exists in ROLE$ table
      const role = session.securityManager.getRole('MYROLE');
      expect(role).toBeDefined();
    });

    it('should allow querying security tables via SQL', () => {
      const session = createSQLPlusSession();

      // Query DBA_USERS equivalent (SYS.USER$)
      const result = executeSQLPlus(session, 'SELECT USERNAME, ACCOUNT_STATUS FROM SYS.USER$ ORDER BY USERNAME;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('SCOTT');
      expect(result.output).toContain('SYSTEM');
    });

    it('should allow querying audit trail via SQL', () => {
      const session = createSQLPlusSession();

      // Create some audit events
      executeSQLPlus(session, 'CREATE USER auditquery IDENTIFIED BY pass;');

      // Query audit trail
      const result = executeSQLPlus(session, "SELECT ACTION_NAME, OBJECT_NAME FROM SYS.AUD$ WHERE ACTION_NAME = 'CREATE_USER' ORDER BY EVENT_TIME DESC;");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('CREATE_USER');
    });
  });
});

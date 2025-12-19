/**
 * Oracle Security Module Tests
 *
 * Tests for authentication, authorization, RBAC, and audit
 */

import { describe, it, expect, beforeEach } from 'vitest';
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

  describe('OracleSecurityManager', () => {
    let secMgr: OracleSecurityManager;

    beforeEach(() => {
      secMgr = new OracleSecurityManager();
    });

    describe('Built-in Users and Roles', () => {
      it('should have SYS user with DBA role', () => {
        const sys = secMgr.getUser('SYS');
        expect(sys).toBeDefined();
        expect(sys!.grantedRoles).toContain('DBA');
        expect(sys!.accountStatus).toBe('OPEN');
      });

      it('should have SYSTEM user with DBA role', () => {
        const system = secMgr.getUser('SYSTEM');
        expect(system).toBeDefined();
        expect(system!.grantedRoles).toContain('DBA');
      });

      it('should have SCOTT demo user', () => {
        const scott = secMgr.getUser('SCOTT');
        expect(scott).toBeDefined();
        expect(scott!.grantedRoles).toContain('CONNECT');
        expect(scott!.grantedRoles).toContain('RESOURCE');
      });

      it('should have built-in roles CONNECT, RESOURCE, DBA', () => {
        expect(secMgr.getRole('CONNECT')).toBeDefined();
        expect(secMgr.getRole('RESOURCE')).toBeDefined();
        expect(secMgr.getRole('DBA')).toBeDefined();
      });

      it('should have DEFAULT profile', () => {
        expect(secMgr.getProfile('DEFAULT')).toBeDefined();
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
        expect(user!.accountStatus).toBe('LOCKED');
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

    describe('User Management', () => {
      it('should create a new user', () => {
        const result = secMgr.createUser('NEWUSER', 'password123');
        expect(result.success).toBe(true);

        const user = secMgr.getUser('NEWUSER');
        expect(user).toBeDefined();
        expect(user!.username).toBe('NEWUSER');
        expect(user!.profile).toBe('DEFAULT');
        expect(user!.accountStatus).toBe('OPEN');
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
        expect(user!.profile).toBe('SECURE_PROFILE');
        expect(user!.accountStatus).toBe('LOCKED');
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
        expect(secMgr.getUser('LOCKTEST')!.accountStatus).toBe('LOCKED');

        secMgr.alterUser('LOCKTEST', { accountUnlock: true });
        expect(secMgr.getUser('LOCKTEST')!.accountStatus).toBe('OPEN');
      });

      it('should drop user', () => {
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

    describe('Role Management', () => {
      it('should create a new role', () => {
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

      it('should grant role to user', () => {
        secMgr.createRole('TESTROLE');
        secMgr.createUser('ROLEUSER', 'pass');

        const result = secMgr.grantRole('TESTROLE', 'ROLEUSER');
        expect(result.success).toBe(true);

        const user = secMgr.getUser('ROLEUSER');
        expect(user!.grantedRoles).toContain('TESTROLE');
      });

      it('should revoke role from user', () => {
        secMgr.createRole('REVOKEROLE');
        secMgr.createUser('REVOKEUSER', 'pass');
        secMgr.grantRole('REVOKEROLE', 'REVOKEUSER');

        const result = secMgr.revokeRole('REVOKEROLE', 'REVOKEUSER');
        expect(result.success).toBe(true);

        const user = secMgr.getUser('REVOKEUSER');
        expect(user!.grantedRoles).not.toContain('REVOKEROLE');
      });

      it('should drop role and remove from all users', () => {
        secMgr.createRole('DROPROLE');
        secMgr.createUser('USER1', 'pass');
        secMgr.createUser('USER2', 'pass');
        secMgr.grantRole('DROPROLE', 'USER1');
        secMgr.grantRole('DROPROLE', 'USER2');

        secMgr.dropRole('DROPROLE');

        expect(secMgr.getUser('USER1')!.grantedRoles).not.toContain('DROPROLE');
        expect(secMgr.getUser('USER2')!.grantedRoles).not.toContain('DROPROLE');
      });

      it('should not allow dropping built-in roles', () => {
        const result = secMgr.dropRole('DBA');
        expect(result.success).toBe(false);
      });
    });

    describe('Privilege Management', () => {
      it('should grant system privilege', () => {
        secMgr.createUser('PRIVUSER', 'pass');

        const result = secMgr.grantSystemPrivilege('CREATE TABLE', 'PRIVUSER');
        expect(result.success).toBe(true);

        const user = secMgr.getUser('PRIVUSER');
        expect(user!.grantedPrivileges).toContain('CREATE TABLE');
      });

      it('should revoke system privilege', () => {
        secMgr.createUser('PRIVUSER2', 'pass');
        secMgr.grantSystemPrivilege('CREATE TABLE', 'PRIVUSER2');

        const result = secMgr.revokeSystemPrivilege('CREATE TABLE', 'PRIVUSER2');
        expect(result.success).toBe(true);

        const user = secMgr.getUser('PRIVUSER2');
        expect(user!.grantedPrivileges).not.toContain('CREATE TABLE');
      });

      it('should grant privilege to role', () => {
        secMgr.createRole('ROLEPRIV');

        secMgr.grantSystemPrivilege('CREATE VIEW', 'ROLEPRIV');

        const role = secMgr.getRole('ROLEPRIV');
        expect(role!.grantedPrivileges.has('CREATE VIEW')).toBe(true);
      });
    });

    describe('Privilege Checking', () => {
      it('should check direct privilege', () => {
        secMgr.createUser('DIRECTPRIV', 'pass');
        secMgr.grantSystemPrivilege('CREATE TABLE', 'DIRECTPRIV');

        expect(secMgr.hasPrivilege('DIRECTPRIV', 'CREATE TABLE')).toBe(true);
        expect(secMgr.hasPrivilege('DIRECTPRIV', 'DROP TABLE')).toBe(false);
      });

      it('should check privilege from role', () => {
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

      it('should get effective privileges', () => {
        secMgr.createUser('EFFPRIV', 'pass');
        secMgr.grantSystemPrivilege('CREATE TABLE', 'EFFPRIV');
        secMgr.grantRole('CONNECT', 'EFFPRIV');

        const effective = secMgr.getEffectivePrivileges('EFFPRIV');
        expect(effective.systemPrivileges).toContain('CREATE TABLE');
        expect(effective.systemPrivileges).toContain('CREATE SESSION');
        expect(effective.roles).toContain('CONNECT');
      });
    });

    describe('Audit Trail', () => {
      it('should audit successful login', () => {
        secMgr.authenticate('SCOTT', 'tiger');

        const trail = secMgr.getAuditTrail({ username: 'SCOTT', action: 'LOGON' });
        expect(trail.length).toBeGreaterThan(0);
        expect(trail[0].returnCode).toBe(0);
      });

      it('should audit failed login', () => {
        secMgr.authenticate('SCOTT', 'wrongpassword');

        const trail = secMgr.getAuditTrail({ username: 'SCOTT', action: 'LOGON_FAILED' });
        expect(trail.length).toBeGreaterThan(0);
        expect(trail[0].returnCode).not.toBe(0);
      });

      it('should audit user creation', () => {
        secMgr.createUser('AUDITUSER', 'pass', undefined, 'SYSTEM');

        const trail = secMgr.getAuditTrail({ action: 'CREATE_USER', objectName: 'AUDITUSER' });
        expect(trail.length).toBe(1);
        expect(trail[0].username).toBe('SYSTEM');
      });

      it('should filter audit trail by criteria', () => {
        // Create several events
        secMgr.createUser('A1', 'pass', undefined, 'SYSTEM');
        secMgr.createUser('A2', 'pass', undefined, 'SYSTEM');
        secMgr.createRole('R1', undefined, 'SYSTEM');

        const userTrail = secMgr.getAuditTrail({ action: 'CREATE_USER' });
        const roleTrail = secMgr.getAuditTrail({ action: 'CREATE_ROLE' });

        expect(userTrail.length).toBeGreaterThanOrEqual(2);
        expect(roleTrail.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('SQLPlus Integration', () => {
    it('should create session with security manager', () => {
      const session = createSQLPlusSession();
      expect(session.securityManager).toBeDefined();
      expect(session.username).toBe('SYSTEM');
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

    it('should execute CREATE USER with proper privileges', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'CREATE USER testuser IDENTIFIED BY password123;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('created');
    });

    it('should execute ALTER USER', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER altertest IDENTIFIED BY oldpass;');
      const result = executeSQLPlus(session, 'ALTER USER altertest IDENTIFIED BY newpass;');
      expect(result.error).toBeUndefined();
    });

    it('should execute DROP USER', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER droptest IDENTIFIED BY pass;');
      const result = executeSQLPlus(session, 'DROP USER droptest;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('dropped');
    });

    it('should execute GRANT role', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER granttest IDENTIFIED BY pass;');
      const result = executeSQLPlus(session, 'GRANT CONNECT TO granttest;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('succeeded');
    });

    it('should execute REVOKE role', () => {
      const session = createSQLPlusSession();

      executeSQLPlus(session, 'CREATE USER revoketest IDENTIFIED BY pass;');
      executeSQLPlus(session, 'GRANT CONNECT TO revoketest;');
      const result = executeSQLPlus(session, 'REVOKE CONNECT FROM revoketest;');
      expect(result.error).toBeUndefined();
      expect(result.feedback).toContain('succeeded');
    });

    it('should execute CREATE ROLE', () => {
      const session = createSQLPlusSession();

      const result = executeSQLPlus(session, 'CREATE ROLE myrole;');
      expect(result.error).toBeUndefined();
    });
  });
});

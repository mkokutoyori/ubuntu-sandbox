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

  describe('Data Dictionary Tables', () => {
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

    describe('Tablespaces (TS$)', () => {
      it('should have default tablespaces', () => {
        const tablespaces = secMgr.getTablespaces();
        expect(tablespaces.length).toBeGreaterThanOrEqual(4);

        const names = tablespaces.map((ts: any) => ts.TABLESPACE_NAME);
        expect(names).toContain('SYSTEM');
        expect(names).toContain('USERS');
        expect(names).toContain('TEMP');
      });

      it('should be queryable via SQL', () => {
        // Tables are in SYS schema and queryable via getTablespaces
        const tablespaces = secMgr.getTablespaces();
        expect(tablespaces.length).toBeGreaterThan(0);

        // Check SYSTEM tablespace exists
        const system = tablespaces.find((ts: any) => ts.TABLESPACE_NAME === 'SYSTEM');
        expect(system).toBeDefined();
        expect(system.CONTENTS).toBe('PERMANENT');
      });
    });

    describe('Data Files (FILE$)', () => {
      it('should have data files for tablespaces', () => {
        const files = secMgr.getDataFiles();
        expect(files.length).toBeGreaterThanOrEqual(3);
      });
    });

    describe('Database Parameters (PARAMETER$)', () => {
      it('should have database parameters', () => {
        const params = secMgr.getParameters();
        expect(params.length).toBeGreaterThanOrEqual(10);
      });

      it('should get specific parameter value', () => {
        const dbName = secMgr.getParameter('db_name');
        expect(dbName).toBe('ORCL');

        const blockSize = secMgr.getParameter('db_block_size');
        expect(blockSize).toBe('8192');
      });
    });

    describe('Object Catalog (OBJ$)', () => {
      it('should register objects', () => {
        const objId = secMgr.registerObject('SCOTT', 'TEST_OBJ', 'TABLE');
        expect(objId).toBeGreaterThan(0);

        const objs = secMgr.getObjects({ owner: 'SCOTT', objectName: 'TEST_OBJ' });
        expect(objs.length).toBe(1);
        expect(objs[0].OBJECT_TYPE).toBe('TABLE');
        expect(objs[0].STATUS).toBe('VALID');
      });

      it('should drop objects', () => {
        secMgr.registerObject('SCOTT', 'DROP_TEST', 'TABLE');
        secMgr.dropObject('SCOTT', 'DROP_TEST', 'TABLE');

        const objs = secMgr.getObjects({ owner: 'SCOTT', objectName: 'DROP_TEST' });
        expect(objs.length).toBe(0);
      });
    });

    describe('Tables (TAB$) and Columns (COL$)', () => {
      it('should register tables with columns', () => {
        const objId = secMgr.registerTable('SCOTT', 'EMPLOYEES', [
          { name: 'EMP_ID', dataType: 'NUMBER', precision: 10, nullable: false },
          { name: 'EMP_NAME', dataType: 'VARCHAR2', length: 100 },
          { name: 'SALARY', dataType: 'NUMBER', precision: 10, scale: 2 },
        ], 'USERS');

        expect(objId).toBeGreaterThan(0);

        // Check TAB$
        const tables = secMgr.getTables('SCOTT');
        const empTable = tables.find((t: any) => t.TABLE_NAME === 'EMPLOYEES');
        expect(empTable).toBeDefined();
        expect(empTable.TABLESPACE_NAME).toBe('USERS');

        // Check COL$
        const columns = secMgr.getColumns('SCOTT', 'EMPLOYEES');
        expect(columns.length).toBe(3);
        expect(columns[0].COLUMN_NAME).toBe('EMP_ID');
        expect(columns[0].NULLABLE).toBe('N');
        expect(columns[1].COLUMN_NAME).toBe('EMP_NAME');
        expect(columns[2].COLUMN_NAME).toBe('SALARY');
      });
    });

    describe('Indexes (IND$)', () => {
      it('should register indexes', () => {
        secMgr.registerTable('SCOTT', 'TEST_TABLE', [
          { name: 'ID', dataType: 'NUMBER' },
          { name: 'NAME', dataType: 'VARCHAR2', length: 50 },
        ]);

        const objId = secMgr.registerIndex('SCOTT', 'IDX_TEST', 'SCOTT', 'TEST_TABLE', ['ID', 'NAME'], true);
        expect(objId).toBeGreaterThan(0);

        const indexes = secMgr.getIndexes('SCOTT', 'TEST_TABLE');
        expect(indexes.length).toBe(1);
        expect(indexes[0].INDEX_NAME).toBe('IDX_TEST');
        expect(indexes[0].UNIQUENESS).toBe('UNIQUE');
      });
    });

    describe('Constraints (CON$)', () => {
      it('should register constraints', () => {
        const conId = secMgr.registerConstraint(
          'SCOTT', 'PK_EMP', 'P', 'EMPLOYEES', ['EMP_ID']
        );
        expect(conId).toBeGreaterThan(0);

        const constraints = secMgr.getConstraints('SCOTT', 'EMPLOYEES');
        expect(constraints.length).toBe(1);
        expect(constraints[0].CONSTRAINT_NAME).toBe('PK_EMP');
        expect(constraints[0].CONSTRAINT_TYPE).toBe('P');
      });
    });

    describe('Sequences (SEQ$)', () => {
      it('should register sequences', () => {
        const objId = secMgr.registerSequence('SCOTT', 'EMP_SEQ', {
          minValue: 1,
          maxValue: 1000000,
          incrementBy: 1,
          cache: 20
        });
        expect(objId).toBeGreaterThan(0);

        const sequences = secMgr.getSequences('SCOTT');
        const seq = sequences.find((s: any) => s.SEQUENCE_NAME === 'EMP_SEQ');
        expect(seq).toBeDefined();
        expect(seq.INCREMENT_BY).toBe(1);
      });
    });

    describe('Views (VIEW$)', () => {
      it('should register views', () => {
        const objId = secMgr.registerView('SCOTT', 'V_EMPLOYEES', 'SELECT * FROM EMPLOYEES');
        expect(objId).toBeGreaterThan(0);

        const views = secMgr.getViews('SCOTT');
        expect(views.length).toBe(1);
        expect(views[0].VIEW_NAME).toBe('V_EMPLOYEES');
        expect(views[0].VIEW_TEXT).toContain('SELECT');
      });
    });

    describe('Synonyms (SYNONYM$)', () => {
      it('should register synonyms', () => {
        secMgr.registerSynonym('PUBLIC', 'EMP', 'SCOTT', 'EMPLOYEES');

        const synonyms = secMgr.getSynonyms('PUBLIC');
        expect(synonyms.length).toBe(1);
        expect(synonyms[0].SYNONYM_NAME).toBe('EMP');
        expect(synonyms[0].TABLE_NAME).toBe('EMPLOYEES');
      });
    });

    describe('Sessions (SESSION$)', () => {
      it('should create and end sessions', () => {
        const session = secMgr.createSession('SCOTT', {
          osuser: 'oracle',
          machine: 'db-server',
          program: 'sqlplus'
        });

        expect(session.sid).toBeGreaterThan(0);
        expect(session.serial).toBeGreaterThan(0);

        const activeSessions = secMgr.getActiveSessions();
        expect(activeSessions.length).toBeGreaterThan(0);

        const scottSession = activeSessions.find((s: any) => s.USERNAME === 'SCOTT');
        expect(scottSession).toBeDefined();
        expect(scottSession.PROGRAM).toBe('sqlplus');

        // End session
        secMgr.endSession(session.sid, session.serial);

        const sessionsAfter = secMgr.getActiveSessions();
        const removed = !sessionsAfter.find((s: any) => s.SID === session.sid && s.SERIAL_NUM === session.serial);
        expect(removed).toBe(true);
      });
    });

    // ============================================================================
    // Password Policy Tests
    // ============================================================================
    describe('Password Policy', () => {
      describe('Password Verification Functions (PASSWORD_VERIFY_FUNC$)', () => {
        it('should have default password verification functions', () => {
          const functions = secMgr.getAllPasswordVerifyFunctions();
          expect(functions.length).toBeGreaterThanOrEqual(3);

          const funcNames = functions.map((f: any) => f.FUNCTION_NAME);
          expect(funcNames).toContain('ORA12C_VERIFY_FUNCTION');
          expect(funcNames).toContain('ORA12C_STRONG_VERIFY_FUNCTION');
          expect(funcNames).toContain('VERIFY_FUNCTION_11G');
        });

        it('should get specific password verification function', () => {
          const func = secMgr.getPasswordVerifyFunction('ORA12C_VERIFY_FUNCTION');
          expect(func).toBeDefined();
          expect(func.MIN_LENGTH).toBe(8);
          expect(func.REQUIRE_UPPERCASE).toBe('Y');
          expect(func.REQUIRE_LOWERCASE).toBe('Y');
          expect(func.REQUIRE_DIGIT).toBe('Y');
        });

        it('should create custom password verification function', () => {
          const result = secMgr.createPasswordVerifyFunction('CUSTOM_VERIFY', {
            minLength: 12,
            maxLength: 40,
            requireUppercase: true,
            requireLowercase: true,
            requireDigit: true,
            requireSpecial: true,
            specialChars: '!@#$%',
            differFromPrevious: 5
          });
          expect(result.success).toBe(true);

          const func = secMgr.getPasswordVerifyFunction('CUSTOM_VERIFY');
          expect(func).toBeDefined();
          expect(func.MIN_LENGTH).toBe(12);
          expect(func.REQUIRE_SPECIAL).toBe('Y');
        });

        it('should prevent duplicate function names', () => {
          secMgr.createPasswordVerifyFunction('DUP_FUNC', {});
          const result = secMgr.createPasswordVerifyFunction('DUP_FUNC', {});
          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('ORA-00955');
        });
      });

      describe('Password Complexity Verification', () => {
        it('should validate password length', () => {
          const result = secMgr.verifyPasswordComplexity('Short1', 'TESTUSER', 'ORA12C_VERIFY_FUNCTION');
          expect(result.valid).toBe(false);
          expect(result.errors.some(e => e.includes('at least 8 characters'))).toBe(true);
        });

        it('should validate uppercase requirement', () => {
          const result = secMgr.verifyPasswordComplexity('password123', 'TESTUSER', 'ORA12C_VERIFY_FUNCTION');
          expect(result.valid).toBe(false);
          expect(result.errors.some(e => e.includes('uppercase'))).toBe(true);
        });

        it('should validate lowercase requirement', () => {
          const result = secMgr.verifyPasswordComplexity('PASSWORD123', 'TESTUSER', 'ORA12C_VERIFY_FUNCTION');
          expect(result.valid).toBe(false);
          expect(result.errors.some(e => e.includes('lowercase'))).toBe(true);
        });

        it('should validate digit requirement', () => {
          const result = secMgr.verifyPasswordComplexity('PasswordABC', 'TESTUSER', 'ORA12C_VERIFY_FUNCTION');
          expect(result.valid).toBe(false);
          expect(result.errors.some(e => e.includes('digit'))).toBe(true);
        });

        it('should reject password containing username', () => {
          const result = secMgr.verifyPasswordComplexity('TestUser123', 'TESTUSER', 'ORA12C_VERIFY_FUNCTION');
          expect(result.valid).toBe(false);
          expect(result.errors.some(e => e.includes('cannot contain the username'))).toBe(true);
        });

        it('should accept valid password', () => {
          const result = secMgr.verifyPasswordComplexity('SecurePass123', 'JOHN', 'ORA12C_VERIFY_FUNCTION');
          expect(result.valid).toBe(true);
          expect(result.errors.length).toBe(0);
        });

        it('should allow any password when no function specified', () => {
          const result = secMgr.verifyPasswordComplexity('weak', 'TESTUSER', null as any);
          expect(result.valid).toBe(true);
        });

        it('should validate special character requirement', () => {
          secMgr.createPasswordVerifyFunction('SPECIAL_REQ', {
            minLength: 8,
            requireSpecial: true
          });

          const invalid = secMgr.verifyPasswordComplexity('Password123', 'TESTUSER', 'SPECIAL_REQ');
          expect(invalid.valid).toBe(false);
          expect(invalid.errors.some(e => e.includes('special character'))).toBe(true);

          const valid = secMgr.verifyPasswordComplexity('Password123!', 'TESTUSER', 'SPECIAL_REQ');
          expect(valid.valid).toBe(true);
        });
      });

      describe('Password History (PASSWORD_HISTORY$)', () => {
        it('should add password to history', () => {
          secMgr.addPasswordToHistory(999, 'HISTUSER', 'hash1');
          secMgr.addPasswordToHistory(999, 'HISTUSER', 'hash2');

          const history = secMgr.getPasswordHistory('HISTUSER');
          expect(history.length).toBe(2);
          // Both hashes should be present
          const hashes = history.map((h: any) => h.PASSWORD_HASH);
          expect(hashes).toContain('hash1');
          expect(hashes).toContain('hash2');
        });

        it('should check password reuse', () => {
          // Create user with secure profile
          secMgr.createUser('REUSETEST', 'Password123', { profile: 'SECURE_PROFILE' });

          // Add some passwords to history
          const user = secMgr.getUser('REUSETEST');
          secMgr.addPasswordToHistory(user.USER_ID, 'REUSETEST', 'oldhash1');
          secMgr.addPasswordToHistory(user.USER_ID, 'REUSETEST', 'oldhash2');

          // Check reuse - should be detected since SECURE_PROFILE has PASSWORD_REUSE_MAX=10
          const reuseCheck = secMgr.isPasswordReused('REUSETEST', 'oldhash1');
          expect(reuseCheck.reused).toBe(true);
          expect(reuseCheck.reason).toContain('ORA-28007');
        });

        it('should allow password reuse when profile allows it', () => {
          // Default profile has UNLIMITED reuse
          secMgr.createUser('ALLOWREUSE', 'Password123');

          const user = secMgr.getUser('ALLOWREUSE');
          secMgr.addPasswordToHistory(user.USER_ID, 'ALLOWREUSE', 'oldhash');

          const reuseCheck = secMgr.isPasswordReused('ALLOWREUSE', 'oldhash');
          expect(reuseCheck.reused).toBe(false);
        });
      });

      describe('Profile Password Settings', () => {
        it('should get profile password settings', () => {
          const settings = secMgr.getProfilePasswordSettings('SECURE_PROFILE');
          expect(settings['FAILED_LOGIN_ATTEMPTS']).toBe('3');
          expect(settings['PASSWORD_LIFE_TIME']).toBe('60');
          expect(settings['PASSWORD_VERIFY_FUNCTION']).toBe('ORA12C_VERIFY_FUNCTION');
        });

        it('should alter profile password setting', () => {
          const result = secMgr.alterProfilePasswordSetting('DEFAULT', 'PASSWORD_LIFE_TIME', '90');
          expect(result.success).toBe(true);

          const settings = secMgr.getProfilePasswordSettings('DEFAULT');
          expect(settings['PASSWORD_LIFE_TIME']).toBe('90');
        });

        it('should get user password verify function', () => {
          secMgr.createUser('SECUREUSER', 'Password123', { profile: 'SECURE_PROFILE' });

          const funcName = secMgr.getUserPasswordVerifyFunction('SECUREUSER');
          expect(funcName).toBe('ORA12C_VERIFY_FUNCTION');
        });
      });
    });

    // ============================================================================
    // Fine-Grained Auditing Tests
    // ============================================================================
    describe('Fine-Grained Auditing (FGA)', () => {
      describe('FGA Policies (FGA_POLICY$)', () => {
        it('should create FGA policy', () => {
          const result = secMgr.addFGAPolicy('HR', 'EMPLOYEES', 'SALARY_AUDIT', {
            auditColumn: 'SALARY',
            auditCondition: 'SALARY > 100000',
            statementTypes: 'SELECT,UPDATE',
            enable: true
          });
          expect(result.success).toBe(true);

          const policies = secMgr.getFGAPolicies('HR', 'EMPLOYEES');
          expect(policies.length).toBe(1);
          expect(policies[0].POLICY_NAME).toBe('SALARY_AUDIT');
          expect(policies[0].POLICY_COLUMN).toBe('SALARY');
          expect(policies[0].ENABLED).toBe('YES');
        });

        it('should prevent duplicate policy names', () => {
          secMgr.addFGAPolicy('HR', 'DEPARTMENTS', 'DUP_POLICY', {});
          const result = secMgr.addFGAPolicy('HR', 'OTHER', 'DUP_POLICY', {});
          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('ORA-28101');
        });

        it('should enable/disable FGA policy', () => {
          secMgr.addFGAPolicy('SCOTT', 'TEST_TABLE', 'TOGGLE_POLICY', { enable: true });

          secMgr.setFGAPolicyEnabled('TOGGLE_POLICY', false);
          let policies = secMgr.getFGAPolicies('SCOTT', 'TEST_TABLE');
          expect(policies[0].ENABLED).toBe('NO');

          secMgr.setFGAPolicyEnabled('TOGGLE_POLICY', true);
          policies = secMgr.getFGAPolicies('SCOTT', 'TEST_TABLE');
          expect(policies[0].ENABLED).toBe('YES');
        });

        it('should drop FGA policy', () => {
          secMgr.addFGAPolicy('SCOTT', 'DROP_TABLE', 'DROP_POLICY', {});

          const dropResult = secMgr.dropFGAPolicy('SCOTT', 'DROP_TABLE', 'DROP_POLICY');
          expect(dropResult.success).toBe(true);

          const policies = secMgr.getFGAPolicies('SCOTT', 'DROP_TABLE');
          expect(policies.length).toBe(0);
        });

        it('should return error when dropping non-existent policy', () => {
          const result = secMgr.dropFGAPolicy('SCOTT', 'TABLE', 'NONEXISTENT');
          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('ORA-28102');
        });
      });

      describe('FGA Audit Log (FGA_LOG$)', () => {
        it('should log FGA events', () => {
          secMgr.addFGAPolicy('SALES', 'ORDERS', 'ORDER_AUDIT', { enable: true });

          secMgr.logFGAEvent('ORDER_AUDIT', 'SALES', 'ORDERS', 'SELECT * FROM ORDERS WHERE AMOUNT > 10000', {
            dbUser: 'SCOTT',
            osUser: 'oracle',
            statementType: 'SELECT',
            sessionId: 100
          });

          const logs = secMgr.getFGAAuditTrail({ policyName: 'ORDER_AUDIT' });
          expect(logs.length).toBeGreaterThan(0);
          expect(logs[0].DB_USER).toBe('SCOTT');
          expect(logs[0].STATEMENT_TYPE).toBe('SELECT');
        });

        it('should filter FGA audit trail', () => {
          secMgr.logFGAEvent('TEST_POLICY', 'HR', 'EMPLOYEES', 'SELECT SALARY FROM EMPLOYEES', {
            dbUser: 'ADMIN',
            statementType: 'SELECT'
          });

          secMgr.logFGAEvent('TEST_POLICY', 'HR', 'EMPLOYEES', 'UPDATE EMPLOYEES SET SALARY = 50000', {
            dbUser: 'MANAGER',
            statementType: 'UPDATE'
          });

          const adminLogs = secMgr.getFGAAuditTrail({ dbUser: 'ADMIN' });
          expect(adminLogs.length).toBeGreaterThan(0);
          expect(adminLogs[0].DB_USER).toBe('ADMIN');

          const hrLogs = secMgr.getFGAAuditTrail({ objectSchema: 'HR' });
          expect(hrLogs.length).toBeGreaterThanOrEqual(2);
        });
      });
    });

    // ============================================================================
    // Unified Audit Tests
    // ============================================================================
    describe('Unified Audit', () => {
      describe('Unified Audit Policies (UNIFIED_AUDIT_POLICY$)', () => {
        it('should create unified audit policy', () => {
          const result = secMgr.createUnifiedAuditPolicy('ALL_LOGON_POLICY', {
            auditOption: 'LOGON',
            auditOptionType: 'STANDARD ACTION'
          });
          expect(result.success).toBe(true);

          const policies = secMgr.getUnifiedAuditPolicies();
          const policy = policies.find((p: any) => p.POLICY_NAME === 'ALL_LOGON_POLICY');
          expect(policy).toBeDefined();
          expect(policy.ENABLED).toBe('NO');
        });

        it('should prevent duplicate policy names', () => {
          secMgr.createUnifiedAuditPolicy('DUP_UNIFIED', {});
          const result = secMgr.createUnifiedAuditPolicy('DUP_UNIFIED', {});
          expect(result.success).toBe(false);
          expect(result.error?.message).toContain('ORA-46358');
        });

        it('should enable/disable unified audit policy', () => {
          secMgr.createUnifiedAuditPolicy('TOGGLE_UNIFIED', {});

          const enableResult = secMgr.enableUnifiedAuditPolicy('TOGGLE_UNIFIED', 'SYS');
          expect(enableResult.success).toBe(true);

          let policies = secMgr.getUnifiedAuditPolicies(true);
          expect(policies.some((p: any) => p.POLICY_NAME === 'TOGGLE_UNIFIED')).toBe(true);

          const disableResult = secMgr.disableUnifiedAuditPolicy('TOGGLE_UNIFIED');
          expect(disableResult.success).toBe(true);

          policies = secMgr.getUnifiedAuditPolicies(true);
          expect(policies.some((p: any) => p.POLICY_NAME === 'TOGGLE_UNIFIED')).toBe(false);
        });

        it('should drop unified audit policy', () => {
          secMgr.createUnifiedAuditPolicy('DROP_UNIFIED', {});

          const result = secMgr.dropUnifiedAuditPolicy('DROP_UNIFIED');
          expect(result.success).toBe(true);

          const policies = secMgr.getUnifiedAuditPolicies();
          expect(policies.some((p: any) => p.POLICY_NAME === 'DROP_UNIFIED')).toBe(false);
        });

        it('should return error when policy does not exist', () => {
          const dropResult = secMgr.dropUnifiedAuditPolicy('NONEXISTENT');
          expect(dropResult.success).toBe(false);
          expect(dropResult.error?.message).toContain('ORA-46355');

          const enableResult = secMgr.enableUnifiedAuditPolicy('NONEXISTENT', 'SYS');
          expect(enableResult.success).toBe(false);
        });
      });

      describe('Unified Audit Trail (UNIFIED_AUDIT_TRAIL$)', () => {
        it('should log unified audit events', () => {
          secMgr.logUnifiedAuditEvent('CREATE_USER', {
            policies: ['USER_MGMT_POLICY'],
            objectSchema: 'SYS',
            dbUsername: 'SYS',
            targetUser: 'NEWUSER',
            returnCode: 0,
            privilegeUsed: 'CREATE USER'
          });

          const trail = secMgr.getUnifiedAuditTrail({ action: 'CREATE_USER' });
          expect(trail.length).toBeGreaterThan(0);
          expect(trail[0].TARGET_USER).toBe('NEWUSER');
          expect(trail[0].SYSTEM_PRIVILEGE_USED).toBe('CREATE USER');
        });

        it('should filter unified audit trail by user', () => {
          secMgr.logUnifiedAuditEvent('SELECT', {
            dbUsername: 'SCOTT',
            objectSchema: 'HR',
            objectName: 'EMPLOYEES',
            sqlText: 'SELECT * FROM EMPLOYEES'
          });

          secMgr.logUnifiedAuditEvent('SELECT', {
            dbUsername: 'HR',
            objectSchema: 'HR',
            objectName: 'DEPARTMENTS',
            sqlText: 'SELECT * FROM DEPARTMENTS'
          });

          const scottTrail = secMgr.getUnifiedAuditTrail({ dbUsername: 'SCOTT' });
          expect(scottTrail.every((t: any) => t.DBUSERNAME === 'SCOTT')).toBe(true);
        });

        it('should filter unified audit trail by policy', () => {
          secMgr.logUnifiedAuditEvent('LOGON', {
            policies: ['LOGON_POLICY', 'SECURITY_POLICY'],
            dbUsername: 'ADMIN'
          });

          const trail = secMgr.getUnifiedAuditTrail({ policyName: 'LOGON_POLICY' });
          expect(trail.length).toBeGreaterThan(0);
          expect(trail[0].UNIFIED_AUDIT_POLICIES).toContain('LOGON_POLICY');
        });
      });
    });

    // ========================================================================
    // DBA Training Features - V$ Views and Performance Tables
    // ========================================================================
    describe('DBA Training Features', () => {

      describe('Redo Logs (V$LOG, V$LOGFILE, V$ARCHIVED_LOG)', () => {
        it('should have redo log groups populated', () => {
          const logs = secMgr['queryTable']('SELECT * FROM V_LOG$');
          expect(logs.length).toBe(3);
          expect(logs.some((l: any) => l.STATUS === 'CURRENT')).toBe(true);
          expect(logs.some((l: any) => l.STATUS === 'INACTIVE')).toBe(true);
        });

        it('should have redo log files with multiplexed members', () => {
          const logFiles = secMgr['queryTable']('SELECT * FROM V_LOGFILE$');
          expect(logFiles.length).toBe(6); // 3 groups x 2 members each
          expect(logFiles.every((f: any) => f.FILE_TYPE === 'ONLINE')).toBe(true);
        });

        it('should have archived logs', () => {
          const archivedLogs = secMgr['queryTable']('SELECT * FROM V_ARCHIVED_LOG$');
          expect(archivedLogs.length).toBe(5);
          expect(archivedLogs.every((a: any) => a.ARCHIVED === 'YES')).toBe(true);
        });

        it('should query logs by status', () => {
          const currentLog = secMgr['queryTable']("SELECT * FROM V_LOG$ WHERE STATUS = 'CURRENT'");
          expect(currentLog.length).toBe(1);
          expect(currentLog[0].ARCHIVED).toBe('NO');
        });
      });

      describe('RMAN Backup (V$RMAN_BACKUP_JOB_DETAILS)', () => {
        it('should have backup job history', () => {
          const backups = secMgr['queryTable']('SELECT * FROM V_RMAN_BACKUP_JOB_DETAILS$');
          expect(backups.length).toBeGreaterThan(0);
          expect(backups.some((b: any) => b.INPUT_TYPE === 'DB FULL')).toBe(true);
          expect(backups.some((b: any) => b.INPUT_TYPE === 'ARCHIVELOG')).toBe(true);
        });

        it('should have backup completion status', () => {
          const completedBackups = secMgr['queryTable']("SELECT * FROM V_RMAN_BACKUP_JOB_DETAILS$ WHERE STATUS = 'COMPLETED'");
          expect(completedBackups.length).toBe(4);
        });

        it('should have backup size information', () => {
          const fullBackup = secMgr['queryTable']("SELECT * FROM V_RMAN_BACKUP_JOB_DETAILS$ WHERE INPUT_TYPE = 'DB FULL'");
          expect(fullBackup.length).toBe(1);
          expect(fullBackup[0].INPUT_BYTES).toBeGreaterThan(0);
          expect(fullBackup[0].OUTPUT_BYTES).toBeGreaterThan(0);
        });
      });

      describe('Memory/SGA (V$SGA, V$SGASTAT)', () => {
        it('should have SGA components', () => {
          const sga = secMgr['queryTable']('SELECT * FROM V_SGA$');
          expect(sga.length).toBe(4);
          expect(sga.some((s: any) => s.NAME === 'Fixed Size')).toBe(true);
          expect(sga.some((s: any) => s.NAME === 'Database Buffers')).toBe(true);
          expect(sga.some((s: any) => s.NAME === 'Redo Buffers')).toBe(true);
        });

        it('should have SGA statistics by pool', () => {
          const sharedPool = secMgr['queryTable']("SELECT * FROM V_SGASTAT$ WHERE POOL = 'shared pool'");
          expect(sharedPool.length).toBeGreaterThan(0);
          expect(sharedPool.some((s: any) => s.COMPONENT_NAME === 'library cache')).toBe(true);
          expect(sharedPool.some((s: any) => s.COMPONENT_NAME === 'sql area')).toBe(true);
        });

        it('should calculate total SGA size', () => {
          const sga = secMgr['queryTable']('SELECT * FROM V_SGA$');
          const totalBytes = sga.reduce((sum: number, s: any) => sum + s.VALUE_BYTES, 0);
          expect(totalBytes).toBeGreaterThan(500000000); // More than 500MB
        });
      });

      describe('Wait Statistics (V$WAITSTAT)', () => {
        it('should have wait class statistics', () => {
          const waits = secMgr['queryTable']('SELECT * FROM V_WAITSTAT$');
          expect(waits.length).toBe(10);
          expect(waits.some((w: any) => w.WAIT_CLASS === 'User I/O')).toBe(true);
          expect(waits.some((w: any) => w.WAIT_CLASS === 'Concurrency')).toBe(true);
        });

        it('should have wait counts and times', () => {
          const userIO = secMgr['queryTable']("SELECT * FROM V_WAITSTAT$ WHERE WAIT_CLASS = 'User I/O'");
          expect(userIO.length).toBe(1);
          expect(userIO[0].COUNT_VAL).toBeGreaterThan(0);
          expect(userIO[0].TIME_VAL).toBeGreaterThan(0);
        });
      });

      describe('SQL Performance (V$SQL, V$SQLAREA)', () => {
        it('should have SQL statements in cache', () => {
          const sql = secMgr['queryTable']('SELECT * FROM V_SQL$');
          expect(sql.length).toBe(5);
        });

        it('should have execution statistics', () => {
          const topSQL = secMgr['queryTable']('SELECT * FROM V_SQL$ ORDER BY BUFFER_GETS DESC');
          expect(topSQL[0].BUFFER_GETS).toBeGreaterThan(0);
          expect(topSQL[0].CPU_TIME).toBeGreaterThan(0);
        });

        it('should filter SQL by parsing schema', () => {
          const hrSQL = secMgr['queryTable']("SELECT * FROM V_SQL$ WHERE PARSING_SCHEMA_NAME = 'HR'");
          expect(hrSQL.length).toBeGreaterThan(0);
        });

        it('should have matching data in V$SQLAREA', () => {
          const sqlarea = secMgr['queryTable']('SELECT * FROM V_SQLAREA$');
          expect(sqlarea.length).toBe(5);
          const sql = secMgr['queryTable']('SELECT * FROM V_SQL$');
          expect(sqlarea.length).toBe(sql.length);
        });
      });

      describe('Scheduler Jobs (DBA_SCHEDULER_JOBS)', () => {
        it('should have scheduler jobs defined', () => {
          const jobs = secMgr['queryTable']('SELECT * FROM SCHEDULER_JOB$');
          expect(jobs.length).toBe(5);
        });

        it('should have system maintenance jobs', () => {
          const sysJobs = secMgr['queryTable']("SELECT * FROM SCHEDULER_JOB$ WHERE OWNER = 'SYS'");
          expect(sysJobs.length).toBe(4);
          expect(sysJobs.some((j: any) => j.JOB_NAME === 'GATHER_STATS_JOB')).toBe(true);
          expect(sysJobs.some((j: any) => j.JOB_NAME === 'BACKUP_JOB')).toBe(true);
        });

        it('should have enabled scheduled jobs', () => {
          const enabledJobs = secMgr['queryTable']("SELECT * FROM SCHEDULER_JOB$ WHERE ENABLED = 'TRUE'");
          expect(enabledJobs.length).toBe(5);
        });

        it('should have different job types', () => {
          const jobs = secMgr['queryTable']('SELECT * FROM SCHEDULER_JOB$');
          const jobTypes = new Set(jobs.map((j: any) => j.JOB_TYPE));
          expect(jobTypes.has('PLSQL_BLOCK')).toBe(true);
          expect(jobTypes.has('STORED_PROCEDURE')).toBe(true);
          expect(jobTypes.has('EXECUTABLE')).toBe(true);
        });
      });

      describe('Resource Manager (DBA_RSRC_PLANS)', () => {
        it('should have resource plans', () => {
          const plans = secMgr['queryTable']('SELECT * FROM RSRC_PLAN$');
          expect(plans.length).toBe(3);
          expect(plans.some((p: any) => p.PLAN === 'DEFAULT_PLAN')).toBe(true);
        });

        it('should have active resource plan', () => {
          const activePlan = secMgr['queryTable']("SELECT * FROM RSRC_PLAN$ WHERE STATUS = 'ACTIVE'");
          expect(activePlan.length).toBe(1);
          expect(activePlan[0].PLAN).toBe('DEFAULT_PLAN');
        });

        it('should have consumer groups', () => {
          const groups = secMgr['queryTable']('SELECT * FROM RSRC_CONSUMER_GROUP$');
          expect(groups.length).toBe(5);
          expect(groups.some((g: any) => g.CONSUMER_GROUP === 'SYS_GROUP')).toBe(true);
          expect(groups.some((g: any) => g.CONSUMER_GROUP === 'BATCH_GROUP')).toBe(true);
        });
      });

      describe('Flashback (FLASHBACK_ARCHIVE$)', () => {
        it('should have flashback archives', () => {
          const archives = secMgr['queryTable']('SELECT * FROM FLASHBACK_ARCHIVE$');
          expect(archives.length).toBe(2);
          expect(archives.some((a: any) => a.FLASHBACK_ARCHIVE_NAME === 'FLA_1YEAR')).toBe(true);
          expect(archives.some((a: any) => a.FLASHBACK_ARCHIVE_NAME === 'FLA_5YEAR')).toBe(true);
        });

        it('should have retention periods', () => {
          const fla1year = secMgr['queryTable']("SELECT * FROM FLASHBACK_ARCHIVE$ WHERE FLASHBACK_ARCHIVE_NAME = 'FLA_1YEAR'");
          expect(fla1year[0].RETENTION_IN_DAYS).toBe(365);

          const fla5year = secMgr['queryTable']("SELECT * FROM FLASHBACK_ARCHIVE$ WHERE FLASHBACK_ARCHIVE_NAME = 'FLA_5YEAR'");
          expect(fla5year[0].RETENTION_IN_DAYS).toBe(1825);
        });

        it('should have flashback database log info', () => {
          const fbLog = secMgr['queryTable']('SELECT * FROM V_FLASHBACK_DATABASE_LOG$');
          expect(fbLog.length).toBe(1);
          expect(fbLog[0].RETENTION_TARGET).toBe(1440);
        });
      });

      describe('Alert Log (V$DIAG_ALERT_EXT)', () => {
        it('should have alert log entries', () => {
          const alerts = secMgr['queryTable']('SELECT * FROM V_DIAG_ALERT_EXT$');
          expect(alerts.length).toBe(10);
        });

        it('should have startup messages', () => {
          const startupMsgs = secMgr['queryTable']("SELECT * FROM V_DIAG_ALERT_EXT$ WHERE MESSAGE_GROUP = 'startup'");
          expect(startupMsgs.length).toBe(5);
        });

        it('should have error and warning messages', () => {
          const errors = secMgr['queryTable']("SELECT * FROM V_DIAG_ALERT_EXT$ WHERE MESSAGE_GROUP = 'error'");
          expect(errors.length).toBe(1);
          expect(errors[0].MESSAGE_TEXT).toContain('ORA-00600');

          const warnings = secMgr['queryTable']("SELECT * FROM V_DIAG_ALERT_EXT$ WHERE MESSAGE_GROUP = 'warning'");
          expect(warnings.length).toBe(1);
          expect(warnings[0].MESSAGE_TEXT).toContain('ORA-01555');
        });

        it('should have message levels for filtering', () => {
          const criticalMsgs = secMgr['queryTable']('SELECT * FROM V_DIAG_ALERT_EXT$ WHERE MESSAGE_LEVEL <= 4');
          expect(criticalMsgs.length).toBe(2); // error and warning
        });
      });
    });
  });
});

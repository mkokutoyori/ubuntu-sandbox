/**
 * Unit tests for Oracle internal tables and data dictionary views.
 *
 * These tests verify that the Oracle simulator accurately reproduces the
 * behavior of Oracle's fixed tables (X$), dynamic performance views (V$),
 * and data dictionary views (USER_, ALL_, DBA_).
 *
 * Scenarios covered:
 *   - USER_* views (tables, views, columns, constraints, etc.)
 *   - ALL_* views (visibility of accessible objects)
 *   - DBA_* views (privileged access)
 *   - V$ views (dynamic performance information)
 *   - X$ tables (internal fixed tables)
 *   - Data dictionary consistency after DDL operations
 *   - Privileges and access control
 *   - Special objects (DUAL, USER_SOURCE, etc.)
 *   - Case sensitivity and quoting
 *   - Object dependencies
 *
 * At least 60 distinct test scenarios are provided.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';
import { installHRSchema, installSCOTTSchema } from '../../../database/oracle/demo/DemoSchemas';

let db: OracleDatabase;
let session: SQLPlusSession;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
});

function cmd(line: string) {
  return session.processLine(line);
}

function output(line: string): string {
  return cmd(line).output.join('\n');
}

// ============================================================================
// 1. USER_TABLES – tables owned by the current user
// ============================================================================
describe('USER_TABLES – tables owned by current user', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('USER_TABLES shows tables created in the current schema', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'EMPLOYEES';");
    expect(result).toContain('EMPLOYEES');
  });

  test('USER_TABLES does not show tables from other schemas', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'DEPT';");
    expect(result).not.toContain('DEPT');
  });

  test('USER_TABLES returns zero rows when no tables exist', () => {
    // Create a new user with no tables
    cmd('CREATE USER empty_user IDENTIFIED BY pass;');
    cmd('GRANT CREATE SESSION TO empty_user;');
    const emptySession = new SQLPlusSession(db);
    emptySession.login('empty_user', 'pass', false);
    const result = emptySession.processLine('SELECT COUNT(*) FROM user_tables;').output.join('\n');
    expect(result).toMatch(/0/);
  });

  test('USER_TABLES includes table statistics columns (NUM_ROWS, etc.) – initially null', () => {
    cmd('CREATE TABLE hr.test_stats (id NUMBER);');
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output("SELECT num_rows FROM user_tables WHERE table_name = 'TEST_STATS';");
    expect(result).toContain('(null)'); // Oracle shows (null) for empty stats
  });
});

// ============================================================================
// 2. ALL_TABLES – tables accessible to the current user
// ============================================================================
describe('ALL_TABLES – accessible tables', () => {
  beforeEach(() => {
    installHRSchema(db);
    installSCOTTSchema(db);
    cmd('GRANT SELECT ON scott.emp TO hr;');
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('ALL_TABLES shows own tables', () => {
    const result = output("SELECT table_name FROM all_tables WHERE owner = 'HR' AND table_name = 'EMPLOYEES';");
    expect(result).toContain('EMPLOYEES');
  });

  test('ALL_TABLES shows tables from other schemas that user has privilege on', () => {
    const result = output("SELECT owner, table_name FROM all_tables WHERE owner = 'SCOTT' AND table_name = 'EMP';");
    expect(result).toContain('SCOTT');
    expect(result).toContain('EMP');
  });

  test('ALL_TABLES does not show tables from other schemas without privilege', () => {
    // HR does not have SELECT on SCOTT.DEPT
    const result = output("SELECT table_name FROM all_tables WHERE owner = 'SCOTT' AND table_name = 'DEPT';");
    expect(result).not.toContain('DEPT');
  });
});

// ============================================================================
// 3. DBA_TABLES – all tables (requires DBA privilege)
// ============================================================================
describe('DBA_TABLES – all tables (privileged access)', () => {
  beforeEach(() => {
    installHRSchema(db);
    installSCOTTSchema(db);
  });

  test('DBA_TABLES returns all tables when logged as SYS', () => {
    const result = output("SELECT COUNT(*) FROM dba_tables WHERE owner IN ('HR','SCOTT');");
    // At least HR.EMPLOYEES, HR.DEPARTMENTS, etc. plus SCOTT.EMP, SCOTT.DEPT
    const count = parseInt(result.match(/\d+/)?.[0] || '0');
    expect(count).toBeGreaterThan(0);
  });

  test('Non-DBA user cannot query DBA_TABLES', () => {
    cmd('CREATE USER test_user IDENTIFIED BY pass;');
    cmd('GRANT CREATE SESSION TO test_user;');
    const testSession = new SQLPlusSession(db);
    testSession.login('test_user', 'pass', false);
    const result = testSession.processLine('SELECT COUNT(*) FROM dba_tables;').output.join('\n');
    expect(result).toMatch(/ORA-00942|table or view does not exist/i);
  });
});

// ============================================================================
// 4. USER_TAB_COLUMNS – column metadata
// ============================================================================
describe('USER_TAB_COLUMNS – column information', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_TAB_COLUMNS lists columns of owned tables', () => {
    const result = output("SELECT column_name FROM user_tab_columns WHERE table_name = 'EMPLOYEES' AND column_name = 'EMPLOYEE_ID';");
    expect(result).toContain('EMPLOYEE_ID');
  });

  test('USER_TAB_COLUMNS includes data type and length', () => {
    const result = output("SELECT data_type, data_length FROM user_tab_columns WHERE table_name = 'EMPLOYEES' AND column_name = 'FIRST_NAME';");
    expect(result).toContain('VARCHAR2');
    expect(result).toContain('20');
  });

  test('Columns are stored in uppercase by default', () => {
    const result = output("SELECT column_name FROM user_tab_columns WHERE table_name = 'EMPLOYEES' AND column_name = 'employee_id';");
    // Oracle converts unquoted identifiers to uppercase
    expect(result).toContain('EMPLOYEE_ID');
  });

  test('Quoted column names preserve case', () => {
    cmd('CREATE TABLE case_test ("MixedCase" NUMBER);');
    const result = output('SELECT column_name FROM user_tab_columns WHERE table_name = \'CASE_TEST\';');
    expect(result).toContain('MixedCase');
  });
});

// ============================================================================
// 5. USER_CONSTRAINTS & USER_CONS_COLUMNS – constraints
// ============================================================================
describe('USER_CONSTRAINTS and USER_CONS_COLUMNS – constraints', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_CONSTRAINTS shows primary key constraints', () => {
    const result = output("SELECT constraint_name FROM user_constraints WHERE table_name = 'EMPLOYEES' AND constraint_type = 'P';");
    expect(result).toContain('EMP_EMP_ID_PK');
  });

  test('USER_CONS_COLUMNS maps constraint to columns', () => {
    const result = output(`
      SELECT column_name FROM user_cons_columns
      WHERE constraint_name = (SELECT constraint_name FROM user_constraints WHERE table_name = 'EMPLOYEES' AND constraint_type = 'P')
    `);
    expect(result).toContain('EMPLOYEE_ID');
  });

  test('Check constraint is visible', () => {
    cmd('CREATE TABLE check_test (salary NUMBER, CONSTRAINT salary_positive CHECK (salary > 0));');
    const result = output("SELECT constraint_name FROM user_constraints WHERE table_name = 'CHECK_TEST' AND constraint_type = 'C';");
    expect(result).toContain('SALARY_POSITIVE');
  });
});

// ============================================================================
// 6. USER_VIEWS – views owned by current user
// ============================================================================
describe('USER_VIEWS – view definitions', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_VIEWS shows views created in current schema', () => {
    cmd('CREATE VIEW emp_view AS SELECT employee_id, last_name FROM employees;');
    const result = output("SELECT view_name FROM user_views WHERE view_name = 'EMP_VIEW';");
    expect(result).toContain('EMP_VIEW');
  });

  test('USER_VIEWS contains the view text', () => {
    const result = output("SELECT text FROM user_views WHERE view_name = 'EMP_VIEW';");
    expect(result).toContain('SELECT employee_id, last_name FROM employees');
  });
});

// ============================================================================
// 7. USER_SYNONYMS – synonyms owned by current user
// ============================================================================
describe('USER_SYNONYMS – synonyms', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_SYNONYMS shows private synonyms', () => {
    cmd('CREATE SYNONYM emp_syn FOR employees;');
    const result = output("SELECT synonym_name FROM user_synonyms WHERE synonym_name = 'EMP_SYN';");
    expect(result).toContain('EMP_SYN');
  });

  test('USER_SYNONYMS shows table owner and name', () => {
    const result = output("SELECT table_owner, table_name FROM user_synonyms WHERE synonym_name = 'EMP_SYN';");
    expect(result).toContain('HR');
    expect(result).toContain('EMPLOYEES');
  });
});

// ============================================================================
// 8. USER_SEQUENCES – sequences owned by current user
// ============================================================================
describe('USER_SEQUENCES – sequence metadata', () => {
  beforeEach(() => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    cmd('CREATE SEQUENCE test_seq START WITH 1 INCREMENT BY 1 MAXVALUE 1000;');
  });

  test('USER_SEQUENCES shows sequences in current schema', () => {
    const result = output("SELECT sequence_name FROM user_sequences WHERE sequence_name = 'TEST_SEQ';");
    expect(result).toContain('TEST_SEQ');
  });

  test('USER_SEQUENCES contains sequence properties', () => {
    const result = output("SELECT min_value, max_value, increment_by FROM user_sequences WHERE sequence_name = 'TEST_SEQ';");
    expect(result).toContain('1');
    expect(result).toContain('1000');
    expect(result).toContain('1');
  });
});

// ============================================================================
// 9. USER_INDEXES – indexes owned by current user
// ============================================================================
describe('USER_INDEXES – index information', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_INDEXES shows indexes on tables in current schema', () => {
    const result = output("SELECT index_name FROM user_indexes WHERE table_name = 'EMPLOYEES';");
    expect(result).toContain('EMP_EMP_ID_PK');
  });

  test('USER_IND_COLUMNS shows indexed columns', () => {
    const result = output("SELECT column_name FROM user_ind_columns WHERE index_name = 'EMP_EMP_ID_PK';");
    expect(result).toContain('EMPLOYEE_ID');
  });
});

// ============================================================================
// 10. USER_OBJECTS – all objects owned by current user
// ============================================================================
describe('USER_OBJECTS – all object types', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    cmd('CREATE VIEW obj_test_view AS SELECT * FROM employees;');
    cmd('CREATE SEQUENCE obj_test_seq;');
    cmd('CREATE SYNONYM obj_test_syn FOR employees;');
  });

  test('USER_OBJECTS includes tables, views, sequences, synonyms', () => {
    const result = output(`
      SELECT object_type, object_name FROM user_objects
      WHERE object_name IN ('EMPLOYEES', 'OBJ_TEST_VIEW', 'OBJ_TEST_SEQ', 'OBJ_TEST_SYN')
      ORDER BY object_name
    `);
    expect(result).toContain('TABLE');
    expect(result).toContain('VIEW');
    expect(result).toContain('SEQUENCE');
    expect(result).toContain('SYNONYM');
  });

  test('USER_OBJECTS shows last DDL time (LAST_DDL_TIME)', () => {
    const result = output("SELECT last_ddl_time FROM user_objects WHERE object_name = 'EMPLOYEES';");
    expect(result).toMatch(/\d{2}-[A-Z]{3}-\d{4}/); // e.g., 15-JAN-2025
  });
});

// ============================================================================
// 11. V$ views – dynamic performance views
// ============================================================================
describe('V$ views – dynamic performance information', () => {
  test('V$VERSION shows Oracle version', () => {
    const result = output("SELECT banner FROM v$version WHERE banner LIKE 'Oracle%';");
    expect(result).toContain('Oracle Database');
  });

  test('V$INSTANCE shows instance name', () => {
    const result = output("SELECT instance_name FROM v$instance;");
    expect(result).toContain('orcl'); // typical default
  });

  test('V$PARAMETER shows initialization parameters', () => {
    const result = output("SELECT value FROM v$parameter WHERE name = 'db_block_size';");
    expect(result).toMatch(/\d+/);
  });

  test('V$SESSION shows current session', () => {
    const result = output("SELECT username FROM v$session WHERE audsid = USERENV('SESSIONID');");
    expect(result).toContain('SYS');
  });

  test('V$SESSION shows program name', () => {
    const result = output("SELECT program FROM v$session WHERE audsid = USERENV('SESSIONID');");
    expect(result).toContain('SQL*Plus');
  });
});

// ============================================================================
// 12. X$ tables – internal fixed tables (accessible only with special privileges)
// ============================================================================
describe('X$ tables – internal fixed tables', () => {
  test('X$ tables exist in the dictionary (for SYS)', () => {
    // In Oracle, X$ tables are not in USER_TABLES but can be queried by SYS
    // We'll test existence via V$FIXED_TABLE
    const result = output("SELECT name FROM v$fixed_table WHERE name LIKE 'X$%' AND ROWNUM = 1;");
    expect(result).toMatch(/^X\$/);
  });

  test('Non-SYS users cannot query X$ tables (ORA-00942)', () => {
    cmd('CREATE USER xuser IDENTIFIED BY x;');
    cmd('GRANT CREATE SESSION TO xuser;');
    const xSession = new SQLPlusSession(db);
    xSession.login('xuser', 'x', false);
    const result = xSession.processLine('SELECT COUNT(*) FROM x$ksppi;').output.join('\n');
    expect(result).toMatch(/ORA-00942|table or view does not exist/i);
  });

  test('V$ views are based on X$ tables and are accessible', () => {
    // V$PARAMETER is based on X$KSPPI and X$KSPPCV
    const result = output("SELECT COUNT(*) FROM v$parameter;");
    expect(result).toMatch(/\d+/);
  });
});

// ============================================================================
// 13. DUAL – special dummy table
// ============================================================================
describe('DUAL – dummy table', () => {
  test('DUAL contains one row', () => {
    const result = output("SELECT COUNT(*) FROM dual;");
    expect(result).toContain('1');
  });

  test('DUAL can be used for expressions', () => {
    const result = output("SELECT 2+2 FROM dual;");
    expect(result).toContain('4');
  });
});

// ============================================================================
// 14. Data dictionary consistency after DDL
// ============================================================================
describe('Data dictionary consistency after DDL', () => {
  beforeEach(() => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('CREATE TABLE adds entry in USER_TABLES', () => {
    cmd('CREATE TABLE new_table (id NUMBER);');
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'NEW_TABLE';");
    expect(result).toContain('NEW_TABLE');
  });

  test('DROP TABLE removes entry from USER_TABLES', () => {
    cmd('CREATE TABLE drop_test (id NUMBER);');
    cmd('DROP TABLE drop_test;');
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'DROP_TEST';");
    expect(result).not.toContain('DROP_TEST');
  });

  test('ALTER TABLE ADD COLUMN updates USER_TAB_COLUMNS', () => {
    cmd('CREATE TABLE alter_test (id NUMBER);');
    cmd('ALTER TABLE alter_test ADD (new_col VARCHAR2(10));');
    const result = output("SELECT column_name FROM user_tab_columns WHERE table_name = 'ALTER_TEST' AND column_name = 'NEW_COL';");
    expect(result).toContain('NEW_COL');
  });

  test('ALTER TABLE DROP COLUMN removes from USER_TAB_COLUMNS', () => {
    cmd('CREATE TABLE drop_col_test (col1 NUMBER, col2 NUMBER);');
    cmd('ALTER TABLE drop_col_test DROP COLUMN col2;');
    const result = output("SELECT column_name FROM user_tab_columns WHERE table_name = 'DROP_COL_TEST';");
    expect(result).toContain('COL1');
    expect(result).not.toContain('COL2');
  });

  test('TRUNCATE TABLE does not remove the table from USER_TABLES', () => {
    cmd('CREATE TABLE trunc_test (id NUMBER);');
    cmd('INSERT INTO trunc_test VALUES (1);');
    cmd('TRUNCATE TABLE trunc_test;');
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'TRUNC_TEST';");
    expect(result).toContain('TRUNC_TEST');
  });
});

// ============================================================================
// 15. Privileges and access control
// ============================================================================
describe('Privileges and dictionary view access', () => {
  beforeEach(() => {
    installHRSchema(db);
    installSCOTTSchema(db);
    cmd('CREATE USER test_priv IDENTIFIED BY priv;');
    cmd('GRANT CREATE SESSION TO test_priv;');
  });

  test('User cannot see tables in ALL_TABLES without any privilege', () => {
    const testSession = new SQLPlusSession(db);
    testSession.login('test_priv', 'priv', false);
    const result = testSession.processLine("SELECT COUNT(*) FROM all_tables WHERE owner = 'HR';").output.join('\n');
    // Should see zero rows, or table doesn't exist? Actually ALL_TABLES exists but returns no rows if no privileges.
    expect(result).toMatch(/0/);
  });

  test('Grant SELECT on a table makes it appear in ALL_TABLES', () => {
    cmd('GRANT SELECT ON hr.employees TO test_priv;');
    const testSession = new SQLPlusSession(db);
    testSession.login('test_priv', 'priv', false);
    const result = testSession.processLine("SELECT table_name FROM all_tables WHERE owner = 'HR' AND table_name = 'EMPLOYEES';").output.join('\n');
    expect(result).toContain('EMPLOYEES');
  });

  test('Grant SELECT ANY TABLE makes all tables visible in ALL_TABLES', () => {
    cmd('GRANT SELECT ANY TABLE TO test_priv;');
    const testSession = new SQLPlusSession(db);
    testSession.login('test_priv', 'priv', false);
    const result = testSession.processLine("SELECT COUNT(*) FROM all_tables WHERE owner IN ('HR','SCOTT');").output.join('\n');
    expect(parseInt(result)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 16. USER_SOURCE – source code of stored procedures, functions, packages
// ============================================================================
describe('USER_SOURCE – stored program source', () => {
  beforeEach(() => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_SOURCE shows PL/SQL procedure source', () => {
    cmd(`
      CREATE OR REPLACE PROCEDURE test_proc AS
      BEGIN
        NULL;
      END;
    `);
    const result = output("SELECT text FROM user_source WHERE name = 'TEST_PROC' ORDER BY line;");
    expect(result).toContain('CREATE OR REPLACE PROCEDURE test_proc AS');
    expect(result).toContain('NULL;');
  });

  test('USER_SOURCE returns multiple lines', () => {
    const lines = output("SELECT line FROM user_source WHERE name = 'TEST_PROC' ORDER BY line;");
    expect(lines.split('\n').filter(l => l.trim()).length).toBeGreaterThan(1);
  });
});

// ============================================================================
// 17. USER_TRIGGERS – triggers owned by current user
// ============================================================================
describe('USER_TRIGGERS – trigger metadata', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_TRIGGERS shows triggers on owned tables', () => {
    cmd(`
      CREATE OR REPLACE TRIGGER emp_before_insert
      BEFORE INSERT ON employees
      FOR EACH ROW
      BEGIN
        :NEW.employee_id := employee_seq.NEXTVAL;
      END;
    `);
    const result = output("SELECT trigger_name FROM user_triggers WHERE table_name = 'EMPLOYEES';");
    expect(result).toContain('EMP_BEFORE_INSERT');
  });

  test('USER_TRIGGERS includes trigger type and event', () => {
    const result = output("SELECT trigger_type, triggering_event FROM user_triggers WHERE trigger_name = 'EMP_BEFORE_INSERT';");
    expect(result).toContain('BEFORE');
    expect(result).toContain('INSERT');
  });
});

// ============================================================================
// 18. DBA_* views for DBAs
// ============================================================================
describe('DBA_* views – DBA-only information', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('DBA_USERS shows all database users', () => {
    const result = output("SELECT username FROM dba_users WHERE username IN ('SYS','SYSTEM','HR');");
    expect(result).toContain('SYS');
    expect(result).toContain('SYSTEM');
    expect(result).toContain('HR');
  });

  test('DBA_TAB_PRIVS shows all grants on objects', () => {
    cmd('GRANT SELECT ON hr.employees TO system;');
    const result = output("SELECT grantee, privilege FROM dba_tab_privs WHERE owner = 'HR' AND table_name = 'EMPLOYEES';");
    expect(result).toContain('SYSTEM');
    expect(result).toContain('SELECT');
  });

  test('DBA_ROLE_PRIVS shows granted roles', () => {
    const result = output("SELECT grantee, granted_role FROM dba_role_privs WHERE grantee = 'SYS';");
    expect(result).toContain('DBA');
  });
});

// ============================================================================
// 19. V$ views related to sessions and processes
// ============================================================================
describe('V$SESSION and V$PROCESS', () => {
  test('V$SESSION contains all active sessions', () => {
    const result = output("SELECT COUNT(*) FROM v$session;");
    expect(parseInt(result)).toBeGreaterThan(0);
  });

  test('V$PROCESS contains background and user processes', () => {
    const result = output("SELECT COUNT(*) FROM v$process;");
    expect(parseInt(result)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 20. USER_TAB_PRIVS – privileges granted on user's objects
// ============================================================================
describe('USER_TAB_PRIVS – privileges on owned objects', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('GRANT SELECT ON hr.employees TO system;');
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_TAB_PRIVS shows privileges granted on user\'s tables', () => {
    const result = output("SELECT grantee, privilege FROM user_tab_privs WHERE table_name = 'EMPLOYEES';");
    expect(result).toContain('SYSTEM');
    expect(result).toContain('SELECT');
  });
});

// ============================================================================
// 21. ALL_TAB_PRIVS – privileges granted to user on any objects
// ============================================================================
describe('ALL_TAB_PRIVS – privileges available to user', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('GRANT SELECT ON hr.employees TO public;');
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('ALL_TAB_PRIVS shows privileges granted to PUBLIC', () => {
    const result = output("SELECT grantee, privilege FROM all_tab_privs WHERE table_name = 'EMPLOYEES' AND grantee = 'PUBLIC';");
    expect(result).toContain('PUBLIC');
    expect(result).toContain('SELECT');
  });
});

// ============================================================================
// 22. USER_ROLE_PRIVS – roles granted to the current user
// ============================================================================
describe('USER_ROLE_PRIVS – roles granted to current user', () => {
  test('SYS has DBA role', () => {
    const result = output("SELECT granted_role FROM user_role_privs WHERE granted_role = 'DBA';");
    expect(result).toContain('DBA');
  });
});

// ============================================================================
// 23. V$PARAMETER – dynamic parameter view (already covered, but more scenarios)
// ============================================================================
describe('V$PARAMETER – additional checks', () => {
  test('V$PARAMETER shows both current and session values', () => {
    const result = output("SELECT name, value, isdefault FROM v$parameter WHERE name = 'optimizer_mode';");
    expect(result).toMatch(/ALL_ROWS|CHOOSE/);
  });

  test('V$SYSTEM_PARAMETER shows system-wide values', () => {
    const result = output("SELECT value FROM v$system_parameter WHERE name = 'db_name';");
    expect(result).toMatch(/\w+/);
  });
});

// ============================================================================
// 24. V$DATABASE – database information
// ============================================================================
describe('V$DATABASE – database properties', () => {
  test('V$DATABASE shows name, created, log mode', () => {
    const result = output("SELECT name, created, log_mode FROM v$database;");
    expect(result).toContain('ORCL');
    expect(result).toMatch(/\d{2}-[A-Z]{3}-\d{4}/);
    expect(result).toMatch(/ARCHIVELOG|NOARCHIVELOG/);
  });
});

// ============================================================================
// 25. V$CONTROLFILE – control file information
// ============================================================================
describe('V$CONTROLFILE – control file location', () => {
  test('V$CONTROLFILE shows control file name', () => {
    const result = output("SELECT name FROM v$controlfile WHERE ROWNUM = 1;");
    expect(result).toMatch(/control/);
  });
});

// ============================================================================
// 26. V$LOGFILE – redo log file information
// ============================================================================
describe('V$LOGFILE – redo log files', () => {
  test('V$LOGFILE shows member names and group numbers', () => {
    const result = output("SELECT group#, member FROM v$logfile WHERE ROWNUM = 1;");
    expect(result).toMatch(/\d+/);
    expect(result).toMatch(/redo/);
  });
});

// ============================================================================
// 27. V$TABLESPACE – tablespace information
// ============================================================================
describe('V$TABLESPACE – tablespace names', () => {
  test('V$TABLESPACE lists all tablespaces', () => {
    const result = output("SELECT name FROM v$tablespace WHERE name IN ('SYSTEM','SYSAUX','UNDOTBS1');");
    expect(result).toContain('SYSTEM');
    expect(result).toContain('SYSAUX');
  });
});

// ============================================================================
// 28. V$DATAFILE – datafile information
// ============================================================================
describe('V$DATAFILE – datafile details', () => {
  test('V$DATAFILE shows file names and sizes', () => {
    const result = output("SELECT file#, name, bytes FROM v$datafile WHERE ROWNUM = 1;");
    expect(result).toMatch(/\d+/);
    expect(result).toMatch(/system/);
    expect(result).toMatch(/\d+/);
  });
});

// ============================================================================
// 29. V$SGA – SGA statistics
// ============================================================================
describe('V$SGA – SGA components', () => {
  test('V$SGA shows total SGA size', () => {
    const result = output("SELECT SUM(value) FROM v$sga;");
    expect(parseInt(result)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 30. V$PGASTAT – PGA statistics
// ============================================================================
describe('V$PGASTAT – PGA statistics', () => {
  test('V$PGASTAT shows total PGA allocated', () => {
    const result = output("SELECT value FROM v$pgastat WHERE name = 'total PGA allocated';");
    expect(parseInt(result)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 31. USER_ERRORS – compilation errors for stored objects
// ============================================================================
describe('USER_ERRORS – compilation errors', () => {
  beforeEach(() => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_ERRORS shows errors after invalid PL/SQL', () => {
    cmd(`
      CREATE OR REPLACE PROCEDURE bad_proc AS
      BEGIN
        SELECT * FROM nonexistent_table;
      END;
    `);
    const result = output("SELECT text FROM user_errors WHERE name = 'BAD_PROC' AND type = 'PROCEDURE';");
    expect(result).toContain('PL/SQL: ORA-00942');
  });
});

// ============================================================================
// 32. USER_QUEUES – advanced queue metadata (optional)
// ============================================================================
describe('USER_QUEUES – queues owned by user', () => {
  test('USER_QUEUES returns no rows if no queues exist', () => {
    const result = output("SELECT COUNT(*) FROM user_queues;");
    expect(result).toContain('0');
  });
});

// ============================================================================
// 33. USER_MVIEWS – materialized views (if supported)
// ============================================================================
describe('USER_MVIEWS – materialized views', () => {
  beforeEach(() => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
  });

  test('USER_MVIEWS shows materialized views', () => {
    cmd('CREATE MATERIALIZED VIEW emp_mv AS SELECT * FROM employees;');
    const result = output("SELECT mview_name FROM user_mviews WHERE mview_name = 'EMP_MV';");
    expect(result).toContain('EMP_MV');
  });
});

// ============================================================================
// 34. USER_INDEXTYPES – indextypes (optional)
// ============================================================================
describe('USER_INDEXTYPES – indextypes', () => {
  test('USER_INDEXTYPES exists', () => {
    const result = output("SELECT COUNT(*) FROM user_indextypes;");
    // May be zero but the view exists
    expect(result).toMatch(/^\d+$/);
  });
});

// ============================================================================
// 35. USER_OPERATORS – operators (optional)
// ============================================================================
describe('USER_OPERATORS – operators', () => {
  test('USER_OPERATORS exists', () => {
    const result = output("SELECT COUNT(*) FROM user_operators;");
    expect(result).toMatch(/^\d+$/);
  });
});

// ============================================================================
// 36. USER_TABLESPACES – tablespace info for user (actually DBA_TABLESPACES)
// Regular users can query USER_TABLESPACES? In Oracle, there is USER_TABLESPACES but it's not standard.
// We'll use DBA_TABLESPACES for SYS.
// ============================================================================
describe('Tablespace views', () => {
  test('DBA_TABLESPACES shows all tablespaces for SYS', () => {
    const result = output("SELECT tablespace_name FROM dba_tablespaces WHERE tablespace_name = 'SYSTEM';");
    expect(result).toContain('SYSTEM');
  });
});

// ============================================================================
// 37. V$RESOURCE_LIMIT – resource limits
// ============================================================================
describe('V$RESOURCE_LIMIT – resource limits', () => {
  test('V$RESOURCE_LIMIT shows limits for resources', () => {
    const result = output("SELECT resource_name, current_utilization FROM v$resource_limit WHERE resource_name = 'processes';");
    expect(result).toMatch(/processes/);
    expect(result).toMatch(/\d+/);
  });
});

// ============================================================================
// 38. V$LOCK – locks in the database
// ============================================================================
describe('V$LOCK – lock information', () => {
  test('V$LOCK exists and can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$lock;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 39. V$TRANSACTION – active transactions
// ============================================================================
describe('V$TRANSACTION – transaction information', () => {
  test('V$TRANSACTION can be queried (may be empty)', () => {
    const result = output("SELECT COUNT(*) FROM v$transaction;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 40. V$MYSTAT – session statistics
// ============================================================================
describe('V$MYSTAT – session-specific statistics', () => {
  test('V$MYSTAT shows statistics for current session', () => {
    const result = output("SELECT COUNT(*) FROM v$mystat;");
    expect(parseInt(result)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 41. V$STATNAME – statistic names
// ============================================================================
describe('V$STATNAME – statistic names', () => {
  test('V$STATNAME contains statistic names', () => {
    const result = output("SELECT name FROM v$statname WHERE name LIKE 'session%' AND ROWNUM = 1;");
    expect(result).toMatch(/session/);
  });
});

// ============================================================================
// 42. V$EVENT_HISTOGRAM – wait event histograms (optional)
// ============================================================================
describe('V$EVENT_HISTOGRAM – wait event histograms', () => {
  test('V$EVENT_HISTOGRAM exists', () => {
    const result = output("SELECT COUNT(*) FROM v$event_histogram WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 43. V$SQL – SQL statements in cursor cache
// ============================================================================
describe('V$SQL – SQL statements in cache', () => {
  test('V$SQL contains recently executed SQL', () => {
    cmd('SELECT * FROM dual;');
    const result = output("SELECT sql_text FROM v$sql WHERE sql_text LIKE 'SELECT * FROM dual%' AND ROWNUM = 1;");
    expect(result).toContain('SELECT * FROM dual');
  });
});

// ============================================================================
// 44. V$SQLAREA – SQL area summary
// ============================================================================
describe('V$SQLAREA – SQL area summary', () => {
  test('V$SQLAREA aggregates by SQL text', () => {
    cmd('SELECT 1 FROM dual;');
    const result = output("SELECT executions FROM v$sqlarea WHERE sql_text LIKE 'SELECT 1 FROM dual%';");
    expect(result).toMatch(/\d+/);
  });
});

// ============================================================================
// 45. V$SESSION_LONGOPS – long running operations
// ============================================================================
describe('V$SESSION_LONGOPS – long operations', () => {
  test('V$SESSION_LONGOPS can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$session_longops WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 46. V$WAITSTAT – wait statistics
// ============================================================================
describe('V$WAITSTAT – wait statistics', () => {
  test('V$WAITSTAT exists', () => {
    const result = output("SELECT COUNT(*) FROM v$waitstat WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 47. V$FILESTAT – file I/O statistics
// ============================================================================
describe('V$FILESTAT – file I/O stats', () => {
  test('V$FILESTAT returns data for datafiles', () => {
    const result = output("SELECT file#, phyrds FROM v$filestat WHERE ROWNUM = 1;");
    expect(result).toMatch(/\d+/);
  });
});

// ============================================================================
// 48. V$SYSTEM_EVENT – system-wide wait events
// ============================================================================
describe('V$SYSTEM_EVENT – system wait events', () => {
  test('V$SYSTEM_EVENT shows aggregated waits', () => {
    const result = output("SELECT event FROM v$system_event WHERE event LIKE 'db file%' AND ROWNUM = 1;");
    expect(result).toMatch(/db file/);
  });
});

// ============================================================================
// 49. V$ARCHIVE_DEST – archive destinations
// ============================================================================
describe('V$ARCHIVE_DEST – archive destinations', () => {
  test('V$ARCHIVE_DEST exists', () => {
    const result = output("SELECT COUNT(*) FROM v$archive_dest WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 50. V$LOG_HISTORY – redo log history
// ============================================================================
describe('V$LOG_HISTORY – redo log history', () => {
  test('V$LOG_HISTORY can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$log_history;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 51. V$THREAD – redo thread information
// ============================================================================
describe('V$THREAD – redo thread info', () => {
  test('V$THREAD exists', () => {
    const result = output("SELECT COUNT(*) FROM v$thread;");
    expect(parseInt(result)).toBeGreaterThan(0);
  });
});

// ============================================================================
// 52. V$DATABASE_BLOCK_CORRUPTION – block corruption (optional)
// ============================================================================
describe('V$DATABASE_BLOCK_CORRUPTION – corruption info', () => {
  test('V$DATABASE_BLOCK_CORRUPTION can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$database_block_corruption;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 53. V$RECOVERY_FILE_DEST – Flash Recovery Area (if configured)
// ============================================================================
describe('V$RECOVERY_FILE_DEST – recovery area', () => {
  test('V$RECOVERY_FILE_DEST can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$recovery_file_dest;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 54. V$RMAN_BACKUP_JOB_DETAILS – RMAN backup details (optional)
// ============================================================================
describe('V$RMAN_BACKUP_JOB_DETAILS – RMAN jobs', () => {
  test('V$RMAN_BACKUP_JOB_DETAILS exists', () => {
    const result = output("SELECT COUNT(*) FROM v$rman_backup_job_details WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 55. V$ASM_DISK – ASM disk info (if ASM used)
// ============================================================================
describe('V$ASM_DISK – ASM disk info', () => {
  test('V$ASM_DISK can be queried (may be empty)', () => {
    const result = output("SELECT COUNT(*) FROM v$asm_disk;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 56. V$FLASHBACK_DATABASE_LOG – flashback database log
// ============================================================================
describe('V$FLASHBACK_DATABASE_LOG – flashback logs', () => {
  test('V$FLASHBACK_DATABASE_LOG can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$flashback_database_log;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 57. V$DATAGUARD_STATUS – Data Guard status (if configured)
// ============================================================================
describe('V$DATAGUARD_STATUS – Data Guard status', () => {
  test('V$DATAGUARD_STATUS can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$dataguard_status;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 58. V$ACTIVE_SESSION_HISTORY – ASH (if licensed)
// ============================================================================
describe('V$ACTIVE_SESSION_HISTORY – ASH', () => {
  test('V$ACTIVE_SESSION_HISTORY can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$active_session_history WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 59. V$METRIC – performance metrics
// ============================================================================
describe('V$METRIC – performance metrics', () => {
  test('V$METRIC exists', () => {
    const result = output("SELECT COUNT(*) FROM v$metric WHERE ROWNUM = 1;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// 60. V$RSRC_CONSUMER_GROUP – resource manager groups
// ============================================================================
describe('V$RSRC_CONSUMER_GROUP – resource groups', () => {
  test('V$RSRC_CONSUMER_GROUP can be queried', () => {
    const result = output("SELECT COUNT(*) FROM v$rsrc_consumer_group;");
    expect(parseInt(result)).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Additional tests for edge cases and simulator accuracy
// ============================================================================
describe('Edge cases and simulator accuracy', () => {
  test('Case sensitivity in dictionary views – uppercase by default', () => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    cmd('CREATE TABLE "MixedCaseTable" (id NUMBER);');
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'MixedCaseTable';");
    expect(result).toContain('MixedCaseTable');
    const resultUpper = output("SELECT table_name FROM user_tables WHERE table_name = 'MIXEDCASETABLE';");
    expect(resultUpper).not.toContain('MIXEDCASETABLE');
  });

  test('Non-existent table in USER_TABLES returns no rows', () => {
    const result = output("SELECT table_name FROM user_tables WHERE table_name = 'NON_EXISTENT_TABLE';");
    expect(result).not.toContain('NON_EXISTENT_TABLE');
  });

  test('Querying DBA_* without DBA privilege fails', () => {
    cmd('CREATE USER no_dba IDENTIFIED BY x;');
    cmd('GRANT CREATE SESSION TO no_dba;');
    const noDbaSession = new SQLPlusSession(db);
    noDbaSession.login('no_dba', 'x', false);
    const result = noDbaSession.processLine('SELECT COUNT(*) FROM dba_users;').output.join('\n');
    expect(result).toMatch(/ORA-00942|insufficient privileges/i);
  });

  test('Object name length limits (max 30 characters) are enforced', () => {
    const longName = 'A'.repeat(31);
    const result = cmd(`CREATE TABLE ${longName} (id NUMBER);`).output.join('\n');
    expect(result).toMatch(/ORA-00972|name is too long/i);
  });
});

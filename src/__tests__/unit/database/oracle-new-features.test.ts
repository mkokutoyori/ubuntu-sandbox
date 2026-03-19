/**
 * Tests for newly implemented Oracle features:
 *   - CTE (WITH clause) execution
 *   - CONNECT BY hierarchical queries
 *   - MERGE statement
 *   - PL/SQL anonymous blocks in SQL*Plus
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';

describe('CTE / WITH clause', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    installAllDemoSchemas(db);
    const conn = db.connectAsSysdba();
    executor = conn.executor;
  });

  it('should execute simple CTE query', () => {
    const result = db.executeSql(executor,
      `WITH dept_summary AS (
        SELECT department_id, COUNT(*) AS cnt FROM HR.EMPLOYEES GROUP BY department_id
      )
      SELECT department_id, cnt FROM dept_summary WHERE cnt > 1`
    );
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('should execute CTE with column aliases', () => {
    const result = db.executeSql(executor,
      `WITH nums AS (SELECT 1 AS n FROM DUAL)
       SELECT n FROM nums`
    );
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(1);
  });

  it('should execute multiple CTEs', () => {
    const result = db.executeSql(executor,
      `WITH
        dept AS (SELECT department_id, department_name FROM HR.DEPARTMENTS),
        emp AS (SELECT employee_id, first_name, department_id FROM HR.EMPLOYEES)
       SELECT e.first_name, d.department_name
       FROM emp e JOIN dept d ON e.department_id = d.department_id`
    );
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe('CONNECT BY hierarchical queries', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    installAllDemoSchemas(db);
    const conn = db.connectAsSysdba();
    executor = conn.executor;
  });

  it('should execute hierarchical query on EMPLOYEES', () => {
    const result = db.executeSql(executor,
      `SELECT employee_id, first_name, manager_id
       FROM HR.EMPLOYEES
       START WITH manager_id IS NULL
       CONNECT BY PRIOR employee_id = manager_id`
    );
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    // First row should be the CEO (no manager)
    const managerIdIdx = result.columns.findIndex(c => c.name === 'MANAGER_ID');
    expect(result.rows[0][managerIdIdx]).toBeNull();
  });
});

describe('MERGE statement', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    installAllDemoSchemas(db);
    const conn = db.connectAsSysdba();
    executor = conn.executor;

    // Create test tables
    db.executeSql(executor, 'CREATE TABLE SYS.merge_target (id NUMBER, name VARCHAR2(50), val NUMBER)');
    db.executeSql(executor, "INSERT INTO SYS.merge_target (id, name, val) VALUES (1, 'Alice', 100)");
    db.executeSql(executor, "INSERT INTO SYS.merge_target (id, name, val) VALUES (2, 'Bob', 200)");

    db.executeSql(executor, 'CREATE TABLE SYS.merge_source (id NUMBER, name VARCHAR2(50), val NUMBER)');
    db.executeSql(executor, "INSERT INTO SYS.merge_source (id, name, val) VALUES (2, 'Robert', 250)");
    db.executeSql(executor, "INSERT INTO SYS.merge_source (id, name, val) VALUES (3, 'Charlie', 300)");
  });

  it('should update matching rows and insert non-matching rows', () => {
    db.executeSql(executor,
      `MERGE INTO SYS.merge_target t
       USING SYS.merge_source s ON (t.id = s.id)
       WHEN MATCHED THEN UPDATE SET t.name = s.name, t.val = s.val
       WHEN NOT MATCHED THEN INSERT (id, name, val) VALUES (s.id, s.name, s.val)`
    );

    const result = db.executeSql(executor, 'SELECT id, name, val FROM SYS.merge_target ORDER BY id');
    expect(result.rows.length).toBe(3);

    // Row 1 unchanged
    expect(result.rows[0][1]).toBe('Alice');
    // Row 2 updated
    expect(result.rows[1][1]).toBe('Robert');
    expect(result.rows[1][2]).toBe(250);
    // Row 3 inserted
    expect(result.rows[2][0]).toBe(3);
    expect(result.rows[2][1]).toBe('Charlie');
  });
});

describe('PL/SQL anonymous blocks', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    installAllDemoSchemas(db);
    const conn = db.connectAsSysdba();
    executor = conn.executor;
    executor.updateContext({ serverOutput: true });
  });

  it('should execute simple BEGIN/END block', () => {
    const result = db.executeSql(executor,
      `BEGIN
         DBMS_OUTPUT.PUT_LINE('Hello World');
       END`
    );
    expect(result.message).toContain('Hello World');
    expect(result.message).toContain('PL/SQL procedure successfully completed');
  });

  it('should execute DECLARE block with variables', () => {
    const result = db.executeSql(executor,
      `DECLARE
         v_name VARCHAR2(50) := 'Test';
       BEGIN
         DBMS_OUTPUT.PUT_LINE('Name: ' || v_name);
       END`
    );
    expect(result.message).toContain('Name: Test');
  });

  it('should execute FOR loop', () => {
    const result = db.executeSql(executor,
      `BEGIN
         FOR i IN 1..3 LOOP
           DBMS_OUTPUT.PUT_LINE('i = ' || i);
         END LOOP;
       END`
    );
    expect(result.message).toContain('i = 1');
    expect(result.message).toContain('i = 2');
    expect(result.message).toContain('i = 3');
  });

  it('should handle IF/ELSIF/ELSE', () => {
    const result = db.executeSql(executor,
      `DECLARE
         v_num NUMBER := 42;
       BEGIN
         IF v_num > 100 THEN
           DBMS_OUTPUT.PUT_LINE('big');
         ELSIF v_num > 10 THEN
           DBMS_OUTPUT.PUT_LINE('medium');
         ELSE
           DBMS_OUTPUT.PUT_LINE('small');
         END IF;
       END`
    );
    expect(result.message).toContain('medium');
  });

  it('should handle exceptions', () => {
    const result = db.executeSql(executor,
      `BEGIN
         RAISE_APPLICATION_ERROR(-20001, 'Custom error');
       EXCEPTION
         WHEN OTHERS THEN
           DBMS_OUTPUT.PUT_LINE('Caught: ' || SQLERRM);
       END`
    );
    expect(result.message).toContain('Caught:');
  });
});

describe('PL/SQL in SQL*Plus session', () => {
  let db: OracleDatabase;
  let session: SQLPlusSession;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    installAllDemoSchemas(db);
    session = new SQLPlusSession(db);
    session.login('SYS', '', true);
    // Enable server output
    session.processLine('SET SERVEROUTPUT ON');
  });

  it('should handle multi-line PL/SQL block', () => {
    let result = session.processLine('BEGIN');
    expect(result.needsMoreInput).toBe(true);

    result = session.processLine("  DBMS_OUTPUT.PUT_LINE('Hello from PL/SQL');");
    expect(result.needsMoreInput).toBe(true);

    result = session.processLine('END;');
    expect(result.needsMoreInput).toBe(false);
    expect(result.output.join('\n')).toContain('Hello from PL/SQL');
  });

  it('should handle DECLARE block', () => {
    let result = session.processLine('DECLARE');
    expect(result.needsMoreInput).toBe(true);

    result = session.processLine("  v_msg VARCHAR2(100) := 'Declared';");
    expect(result.needsMoreInput).toBe(true);

    result = session.processLine('BEGIN');
    expect(result.needsMoreInput).toBe(true);

    result = session.processLine('  DBMS_OUTPUT.PUT_LINE(v_msg);');
    expect(result.needsMoreInput).toBe(true);

    result = session.processLine('END;');
    expect(result.needsMoreInput).toBe(false);
    expect(result.output.join('\n')).toContain('Declared');
  });
});

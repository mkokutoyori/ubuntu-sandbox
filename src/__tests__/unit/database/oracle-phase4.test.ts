/**
 * TDD Tests — Phase 4: Window Functions, PL/SQL, lsnrctl
 *
 * RED phase: these tests define the desired behavior.
 * GREEN phase: implement features to make them pass.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';

let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

// Helper to execute SQL and return result
function exec(db: OracleDatabase, sql: string) {
  return db.executeSql(executor, sql);
}

describe('Window / Analytic Functions', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    const conn = db.connectAsSysdba();
    executor = conn.executor;

    exec(db, `CREATE TABLE sales (
      id NUMBER PRIMARY KEY,
      rep VARCHAR2(50),
      region VARCHAR2(50),
      amount NUMBER,
      sale_date DATE
    )`);
    exec(db, `INSERT INTO sales VALUES (1, 'Alice', 'East', 1000, DATE '2024-01-15')`);
    exec(db, `INSERT INTO sales VALUES (2, 'Bob', 'East', 1500, DATE '2024-01-20')`);
    exec(db, `INSERT INTO sales VALUES (3, 'Alice', 'East', 800, DATE '2024-02-10')`);
    exec(db, `INSERT INTO sales VALUES (4, 'Charlie', 'West', 2000, DATE '2024-01-25')`);
    exec(db, `INSERT INTO sales VALUES (5, 'Diana', 'West', 1200, DATE '2024-02-05')`);
    exec(db, `INSERT INTO sales VALUES (6, 'Bob', 'East', 900, DATE '2024-02-15')`);
    exec(db, `INSERT INTO sales VALUES (7, 'Charlie', 'West', 1800, DATE '2024-02-20')`);
    exec(db, `INSERT INTO sales VALUES (8, 'Alice', 'East', 1100, DATE '2024-03-01')`);
  });

  describe('ROW_NUMBER()', () => {
    test('assigns sequential numbers across all rows', () => {
      const result = exec(db, `
        SELECT rep, amount, ROW_NUMBER() OVER (ORDER BY amount DESC) AS rn
        FROM sales
        ORDER BY amount DESC
      `);
      expect(result.rows.length).toBe(8);
      // Highest amount first (ordered by amount DESC)
      expect(result.rows[0][2]).toBe(1); // rn=1 for highest
      expect(result.rows[7][2]).toBe(8); // rn=8 for lowest
    });

    test('assigns numbers within partitions', () => {
      const result = exec(db, `
        SELECT rep, amount, ROW_NUMBER() OVER (PARTITION BY region ORDER BY amount DESC) AS rn
        FROM sales
      `);
      expect(result.rows.length).toBe(8);
      // Each partition resets to 1
      const eastRows = result.rows.filter(r => {
        // Find the region column — need to check by rep
        return ['Alice', 'Bob'].includes(r[0] as string);
      });
      const rnValues = eastRows.map(r => r[2]);
      expect(rnValues).toContain(1); // First in partition
    });
  });

  describe('RANK()', () => {
    test('assigns rank with gaps for ties', () => {
      exec(db, `CREATE TABLE scores (name VARCHAR2(20), score NUMBER)`);
      exec(db, `INSERT INTO scores VALUES ('A', 100)`);
      exec(db, `INSERT INTO scores VALUES ('B', 90)`);
      exec(db, `INSERT INTO scores VALUES ('C', 90)`);
      exec(db, `INSERT INTO scores VALUES ('D', 80)`);

      const result = exec(db, `
        SELECT name, score, RANK() OVER (ORDER BY score DESC) AS rnk
        FROM scores
      `);
      expect(result.rows[0][2]).toBe(1); // A: rank 1
      expect(result.rows[1][2]).toBe(2); // B: rank 2 (tie)
      expect(result.rows[2][2]).toBe(2); // C: rank 2 (tie)
      expect(result.rows[3][2]).toBe(4); // D: rank 4 (gap!)
    });
  });

  describe('DENSE_RANK()', () => {
    test('assigns rank without gaps for ties', () => {
      exec(db, `CREATE TABLE scores (name VARCHAR2(20), score NUMBER)`);
      exec(db, `INSERT INTO scores VALUES ('A', 100)`);
      exec(db, `INSERT INTO scores VALUES ('B', 90)`);
      exec(db, `INSERT INTO scores VALUES ('C', 90)`);
      exec(db, `INSERT INTO scores VALUES ('D', 80)`);

      const result = exec(db, `
        SELECT name, score, DENSE_RANK() OVER (ORDER BY score DESC) AS drnk
        FROM scores
      `);
      expect(result.rows[0][2]).toBe(1); // A: dense_rank 1
      expect(result.rows[1][2]).toBe(2); // B: dense_rank 2 (tie)
      expect(result.rows[2][2]).toBe(2); // C: dense_rank 2 (tie)
      expect(result.rows[3][2]).toBe(3); // D: dense_rank 3 (no gap!)
    });
  });

  describe('SUM() OVER', () => {
    test('running total with ORDER BY', () => {
      const result = exec(db, `
        SELECT id, amount, SUM(amount) OVER (ORDER BY id) AS running_total
        FROM sales
        ORDER BY id
      `);
      expect(result.rows[0][2]).toBe(1000);  // 1000
      expect(result.rows[1][2]).toBe(2500);  // 1000+1500
      expect(result.rows[2][2]).toBe(3300);  // +800
    });

    test('partition sum without ORDER BY', () => {
      const result = exec(db, `
        SELECT rep, amount, SUM(amount) OVER (PARTITION BY region) AS region_total
        FROM sales
        ORDER BY id
      `);
      // East total: 1000+1500+800+900+1100 = 5300
      expect(result.rows[0][2]).toBe(5300);  // Alice/East
      expect(result.rows[1][2]).toBe(5300);  // Bob/East
      // West total: 2000+1200+1800 = 5000
      expect(result.rows[3][2]).toBe(5000);  // Charlie/West
    });
  });

  describe('COUNT() OVER', () => {
    test('count within partition', () => {
      const result = exec(db, `
        SELECT rep, COUNT(*) OVER (PARTITION BY rep) AS rep_count
        FROM sales
        ORDER BY rep
      `);
      // Alice has 3 sales, Bob has 2, Charlie has 2, Diana has 1
      const aliceRows = result.rows.filter(r => r[0] === 'Alice');
      expect(aliceRows[0][1]).toBe(3);
    });
  });

  describe('LAG and LEAD', () => {
    test('LAG returns previous row value', () => {
      const result = exec(db, `
        SELECT id, amount, LAG(amount, 1) OVER (ORDER BY id) AS prev_amount
        FROM sales
        ORDER BY id
      `);
      expect(result.rows[0][2]).toBe(null); // No previous for first row
      expect(result.rows[1][2]).toBe(1000);  // Previous is first row's amount
      expect(result.rows[2][2]).toBe(1500);  // Previous is second row's amount
    });

    test('LEAD returns next row value', () => {
      const result = exec(db, `
        SELECT id, amount, LEAD(amount, 1) OVER (ORDER BY id) AS next_amount
        FROM sales
        ORDER BY id
      `);
      expect(result.rows[0][2]).toBe(1500);  // Next is second row's amount
      expect(result.rows[7][2]).toBe(null);  // No next for last row
    });

    test('LAG with default value', () => {
      const result = exec(db, `
        SELECT id, amount, LAG(amount, 1, 0) OVER (ORDER BY id) AS prev_amount
        FROM sales
        ORDER BY id
      `);
      expect(result.rows[0][2]).toBe(0); // Default value for first row
    });
  });

  describe('NTILE', () => {
    test('distributes rows into n buckets', () => {
      const result = exec(db, `
        SELECT id, NTILE(4) OVER (ORDER BY id) AS quartile
        FROM sales
        ORDER BY id
      `);
      // 8 rows into 4 buckets: 2 per bucket
      expect(result.rows[0][1]).toBe(1); // bucket 1
      expect(result.rows[1][1]).toBe(1); // bucket 1
      expect(result.rows[2][1]).toBe(2); // bucket 2
      expect(result.rows[3][1]).toBe(2); // bucket 2
      expect(result.rows[6][1]).toBe(4); // bucket 4
      expect(result.rows[7][1]).toBe(4); // bucket 4
    });
  });
});

describe('PL/SQL Anonymous Blocks', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    const conn = db.connectAsSysdba();
    executor = conn.executor;
  });

  describe('Simple blocks', () => {
    test('executes BEGIN...END block', () => {
      const result = exec(db, `
        BEGIN
          NULL;
        END;
      `);
      expect(result.message).toContain('PL/SQL procedure successfully completed');
    });

    test('DBMS_OUTPUT.PUT_LINE produces output', () => {
      // Enable server output first
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        BEGIN
          DBMS_OUTPUT.PUT_LINE('Hello, Oracle!');
        END;
      `);
      expect(result.message).toContain('Hello, Oracle!');
    });

    test('multiple DBMS_OUTPUT.PUT_LINE calls', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        BEGIN
          DBMS_OUTPUT.PUT_LINE('Line 1');
          DBMS_OUTPUT.PUT_LINE('Line 2');
          DBMS_OUTPUT.PUT_LINE('Line 3');
        END;
      `);
      expect(result.message).toContain('Line 1');
      expect(result.message).toContain('Line 2');
      expect(result.message).toContain('Line 3');
    });
  });

  describe('Variable declarations', () => {
    test('DECLARE block with variable assignment', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_name VARCHAR2(50) := 'World';
        BEGIN
          DBMS_OUTPUT.PUT_LINE('Hello, ' || v_name || '!');
        END;
      `);
      expect(result.message).toContain('Hello, World!');
    });

    test('variable assignment from SELECT INTO', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO v_count FROM DUAL;
          DBMS_OUTPUT.PUT_LINE('Count: ' || v_count);
        END;
      `);
      expect(result.message).toContain('Count: 1');
    });

    test('NUMBER variable arithmetic', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_a NUMBER := 10;
          v_b NUMBER := 20;
          v_sum NUMBER;
        BEGIN
          v_sum := v_a + v_b;
          DBMS_OUTPUT.PUT_LINE('Sum: ' || v_sum);
        END;
      `);
      expect(result.message).toContain('Sum: 30');
    });
  });

  describe('Control flow', () => {
    test('IF-THEN-ELSE', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_val NUMBER := 42;
        BEGIN
          IF v_val > 50 THEN
            DBMS_OUTPUT.PUT_LINE('Big');
          ELSE
            DBMS_OUTPUT.PUT_LINE('Small');
          END IF;
        END;
      `);
      expect(result.message).toContain('Small');
    });

    test('IF-ELSIF-ELSE', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_grade NUMBER := 85;
        BEGIN
          IF v_grade >= 90 THEN
            DBMS_OUTPUT.PUT_LINE('A');
          ELSIF v_grade >= 80 THEN
            DBMS_OUTPUT.PUT_LINE('B');
          ELSIF v_grade >= 70 THEN
            DBMS_OUTPUT.PUT_LINE('C');
          ELSE
            DBMS_OUTPUT.PUT_LINE('F');
          END IF;
        END;
      `);
      expect(result.message).toContain('B');
    });

    test('FOR loop', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        BEGIN
          FOR i IN 1..5 LOOP
            DBMS_OUTPUT.PUT_LINE('i=' || i);
          END LOOP;
        END;
      `);
      expect(result.message).toContain('i=1');
      expect(result.message).toContain('i=5');
    });

    test('WHILE loop', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_count NUMBER := 1;
        BEGIN
          WHILE v_count <= 3 LOOP
            DBMS_OUTPUT.PUT_LINE('count=' || v_count);
            v_count := v_count + 1;
          END LOOP;
        END;
      `);
      expect(result.message).toContain('count=1');
      expect(result.message).toContain('count=3');
    });
  });

  describe('Exception handling', () => {
    test('catches predefined exceptions', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        DECLARE
          v_val NUMBER;
        BEGIN
          SELECT 1/0 INTO v_val FROM DUAL;
          DBMS_OUTPUT.PUT_LINE('Should not reach here');
        EXCEPTION
          WHEN ZERO_DIVIDE THEN
            DBMS_OUTPUT.PUT_LINE('Division by zero caught');
        END;
      `);
      expect(result.message).toContain('Division by zero caught');
    });

    test('WHEN OTHERS catches all', () => {
      exec(db, "ALTER SESSION SET SERVEROUTPUT = ON");
      const result = exec(db, `
        BEGIN
          RAISE_APPLICATION_ERROR(-20001, 'Custom error');
        EXCEPTION
          WHEN OTHERS THEN
            DBMS_OUTPUT.PUT_LINE('Caught: ' || SQLERRM);
        END;
      `);
      expect(result.message).toContain('Caught:');
    });
  });

  describe('SQL in PL/SQL', () => {
    test('DML inside PL/SQL block', () => {
      exec(db, `CREATE TABLE test_plsql (id NUMBER, name VARCHAR2(50))`);
      const result = exec(db, `
        BEGIN
          INSERT INTO test_plsql VALUES (1, 'Test');
          INSERT INTO test_plsql VALUES (2, 'Test2');
        END;
      `);
      expect(result.message).toContain('PL/SQL procedure successfully completed');
      const check = exec(db, `SELECT COUNT(*) FROM test_plsql`);
      expect(check.rows[0][0]).toBe(2);
    });
  });
});

describe('Listener Control (lsnrctl)', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    const conn = db.connectAsSysdba();
    executor = conn.executor;
  });

  describe('Listener state', () => {
    test('listener starts in stopped state', () => {
      expect(db.instance.listenerStatus).toBe('stopped');
    });

    test('start listener', () => {
      const result = db.instance.startListener();
      expect(result).toContain('started successfully');
      expect(db.instance.listenerStatus).toBe('running');
    });

    test('stop listener', () => {
      db.instance.startListener();
      const result = db.instance.stopListener();
      expect(result).toContain('stopped');
      expect(db.instance.listenerStatus).toBe('stopped');
    });

    test('listener status when running', () => {
      db.instance.startListener();
      const result = db.instance.getListenerStatus();
      expect(result).toContain('LISTENER');
      expect(result).toContain('1521');
      expect(result).toContain('ORCL');
    });

    test('listener status when stopped', () => {
      const result = db.instance.getListenerStatus();
      expect(result).toContain('no listener');
    });
  });
});

describe('Oracle Filesystem and Config', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    const conn = db.connectAsSysdba();
    executor = conn.executor;
  });

  describe('Environment variables', () => {
    test('ORACLE_HOME is set', () => {
      expect(db.instance.getParameter('ORACLE_HOME')).toBe('/u01/app/oracle/product/19c/dbhome_1');
    });

    test('ORACLE_SID is set', () => {
      expect(db.instance.getParameter('ORACLE_SID')).toBe('ORCL');
    });
  });

  describe('Configuration files content', () => {
    test('getInitOraContent returns init parameters', () => {
      const content = db.instance.getInitOraContent();
      expect(content).toContain('db_name');
      expect(content).toContain('ORCL');
      expect(content).toContain('sga_target');
      expect(content).toContain('processes');
    });

    test('getTnsNamesContent returns TNS entries', () => {
      const content = db.instance.getTnsNamesContent();
      expect(content).toContain('ORCL');
      expect(content).toContain('1521');
      expect(content).toContain('SERVICE_NAME');
    });

    test('getListenerOraContent returns listener config', () => {
      const content = db.instance.getListenerOraContent();
      expect(content).toContain('LISTENER');
      expect(content).toContain('1521');
      expect(content).toContain('SID_LIST');
    });
  });

  describe('Alert log', () => {
    test('records startup events', () => {
      // Instance is already started via connect
      const log = db.instance.getAlertLog();
      expect(log.length).toBeGreaterThan(0);
      expect(log.some(entry => entry.includes('Starting ORACLE instance'))).toBe(true);
    });

    test('records shutdown events', () => {
      db.instance.shutdown('IMMEDIATE');
      const log = db.instance.getAlertLog();
      expect(log.some(entry => entry.includes('Shutting down'))).toBe(true);
    });
  });
});

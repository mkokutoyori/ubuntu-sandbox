/**
 * SQL Integration Tests
 *
 * Comprehensive tests based on documentation in docs/postgres.md and docs/oracle.md
 * Tests cover:
 * - PostgreSQL psql interface and meta-commands
 * - Oracle SQL*Plus interface
 * - SQL functions for both databases
 * - Complex queries (JOINs, GROUP BY, aggregations)
 * - Real-world usage scenarios
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenizeSQL, SQLTokenType } from '../terminal/sql/generic/lexer';
import { parseSQL } from '../terminal/sql/generic/parser';
import { SQLEngine } from '../terminal/sql/generic/engine';
import { createPsqlSession, executePsql, getPsqlPrompt } from '../terminal/sql/postgres/psql';
import { createSQLPlusSession, executeSQLPlus, getSQLPlusPrompt } from '../terminal/sql/oracle/sqlplus';

// ============================================
// PostgreSQL psql Interface Tests
// ============================================
describe('PostgreSQL psql Interface', () => {
  let session: ReturnType<typeof createPsqlSession>;

  beforeEach(() => {
    session = createPsqlSession();
  });

  describe('Session Management', () => {
    it('creates a valid session', () => {
      expect(session).toBeDefined();
      expect(session.engine).toBeDefined();
      expect(session.connected).toBe(true);
    });

    it('returns correct prompt format', () => {
      const prompt = getPsqlPrompt(session);
      expect(prompt).toContain('postgres');
    });
  });

  describe('Meta-commands from docs/postgres.md', () => {
    it('handles \\q (quit)', () => {
      const result = executePsql(session, '\\q');
      expect(result.exit).toBe(true);
    });

    it('handles \\? (help on meta-commands)', () => {
      const result = executePsql(session, '\\?');
      expect(result.output).toBeDefined();
      expect(result.output).toContain('General');
    });

    it('handles \\h (SQL help)', () => {
      const result = executePsql(session, '\\h');
      expect(result.output).toBeDefined();
    });

    it('handles \\l (list databases)', () => {
      const result = executePsql(session, '\\l');
      expect(result.output).toBeDefined();
    });

    it('handles \\conninfo (connection info)', () => {
      const result = executePsql(session, '\\conninfo');
      expect(result.output).toContain('connected');
    });

    it('handles \\dt (list tables)', () => {
      const result = executePsql(session, '\\dt');
      expect(result.output).toBeDefined();
    });

    it('handles \\x (toggle expanded display)', () => {
      const result = executePsql(session, '\\x');
      expect(result.output).toContain('Expanded display');
    });

    it('handles \\timing (toggle timing)', () => {
      const result = executePsql(session, '\\timing');
      expect(result.output).toContain('Timing');
    });

    it('handles \\p (print buffer)', () => {
      const result = executePsql(session, '\\p');
      expect(result.output).toBeDefined();
    });

    it('handles \\r (reset buffer)', () => {
      const result = executePsql(session, '\\r');
      expect(result.output).toBeDefined();
    });
  });

  describe('SQL Commands from docs/postgres.md', () => {
    it('creates table with SERIAL and constraints', () => {
      const result = executePsql(session, `
        CREATE TABLE employees (
          id SERIAL PRIMARY KEY,
          name VARCHAR(100),
          department VARCHAR(50),
          salary NUMERIC(10,2),
          hire_date DATE DEFAULT CURRENT_DATE
        );
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('CREATE TABLE');
    });

    it('inserts data with column specification', () => {
      executePsql(session, 'CREATE TABLE employees (id SERIAL PRIMARY KEY, name VARCHAR(100), department VARCHAR(50), salary NUMERIC(10,2));');
      const result = executePsql(session, "INSERT INTO employees (name, department, salary) VALUES ('John Doe', 'IT', 75000);");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('INSERT');
    });

    it('selects all data', () => {
      executePsql(session, 'CREATE TABLE employees (id INTEGER, name VARCHAR(100));');
      executePsql(session, "INSERT INTO employees (id, name) VALUES (1, 'John');");
      const result = executePsql(session, 'SELECT * FROM employees;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('John');
    });

    it('updates data with WHERE', () => {
      executePsql(session, 'CREATE TABLE employees (id INTEGER, salary INTEGER);');
      executePsql(session, 'INSERT INTO employees (id, salary) VALUES (1, 75000);');
      const result = executePsql(session, 'UPDATE employees SET salary = 80000 WHERE id = 1;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('UPDATE');
    });

    it('deletes data with WHERE', () => {
      executePsql(session, 'CREATE TABLE employees (id INTEGER, name VARCHAR(100));');
      executePsql(session, "INSERT INTO employees (id, name) VALUES (1, 'John'), (2, 'Jane');");
      const result = executePsql(session, 'DELETE FROM employees WHERE id = 2;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('DELETE');
    });
  });

  describe('Transactions from docs/postgres.md', () => {
    it('handles BEGIN', () => {
      const result = executePsql(session, 'BEGIN;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('BEGIN');
    });

    it('handles COMMIT', () => {
      executePsql(session, 'BEGIN;');
      const result = executePsql(session, 'COMMIT;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('COMMIT');
    });

    it('handles ROLLBACK', () => {
      executePsql(session, 'BEGIN;');
      const result = executePsql(session, 'ROLLBACK;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('ROLLBACK');
    });
  });
});

// ============================================
// Oracle SQL*Plus Interface Tests
// ============================================
describe('Oracle SQL*Plus Interface', () => {
  let session: ReturnType<typeof createSQLPlusSession>;

  beforeEach(() => {
    session = createSQLPlusSession();
  });

  describe('Session Management', () => {
    it('creates a valid session', () => {
      expect(session).toBeDefined();
      expect(session.engine).toBeDefined();
      expect(session.connected).toBe(true);
    });

    it('returns correct prompt format', () => {
      const prompt = getSQLPlusPrompt(session);
      expect(prompt).toContain('SQL');
    });
  });

  describe('SQL*Plus Commands from docs/oracle.md', () => {
    it('handles EXIT', () => {
      const result = executeSQLPlus(session, 'EXIT');
      expect(result.exit).toBe(true);
    });

    it('handles QUIT', () => {
      const result = executeSQLPlus(session, 'QUIT');
      expect(result.exit).toBe(true);
    });

    it('handles HELP', () => {
      const result = executeSQLPlus(session, 'HELP');
      expect(result.output).toBeDefined();
    });

    it('handles SHOW ALL', () => {
      const result = executeSQLPlus(session, 'SHOW ALL');
      expect(result.output).toBeDefined();
    });

    it('handles SHOW USER', () => {
      const result = executeSQLPlus(session, 'SHOW USER');
      expect(result.output).toBeDefined();
    });

    it('handles SET LINESIZE', () => {
      const result = executeSQLPlus(session, 'SET LINESIZE 200');
      expect(result.error).toBeUndefined();
    });

    it('handles SET PAGESIZE', () => {
      const result = executeSQLPlus(session, 'SET PAGESIZE 50');
      expect(result.error).toBeUndefined();
    });

    it('handles SET FEEDBACK', () => {
      const result = executeSQLPlus(session, 'SET FEEDBACK ON');
      expect(result.error).toBeUndefined();
    });

    it('handles DESCRIBE', () => {
      executeSQLPlus(session, 'CREATE TABLE employees (id NUMBER, name VARCHAR2(100));');
      const result = executeSQLPlus(session, 'DESC employees');
      expect(result.output).toBeDefined();
    });
  });

  describe('SQL Commands from docs/oracle.md', () => {
    it('creates table with NUMBER and VARCHAR2', () => {
      const result = executeSQLPlus(session, `
        CREATE TABLE employees (
          id NUMBER PRIMARY KEY,
          name VARCHAR2(100),
          department VARCHAR2(50),
          salary NUMBER(10,2),
          hire_date DATE
        );
      `);
      expect(result.error).toBeUndefined();
    });

    it('inserts data', () => {
      executeSQLPlus(session, 'CREATE TABLE employees (id NUMBER, name VARCHAR2(100), department VARCHAR2(50), salary NUMBER);');
      const result = executeSQLPlus(session, "INSERT INTO employees VALUES (1, 'John Doe', 'IT', 75000);");
      expect(result.error).toBeUndefined();
    });

    it('selects all data', () => {
      executeSQLPlus(session, 'CREATE TABLE employees (id NUMBER, name VARCHAR2(100));');
      executeSQLPlus(session, "INSERT INTO employees (id, name) VALUES (1, 'John');");
      const result = executeSQLPlus(session, 'SELECT * FROM employees;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('John');
    });

    it('updates data with WHERE', () => {
      executeSQLPlus(session, 'CREATE TABLE employees (id NUMBER, salary NUMBER);');
      executeSQLPlus(session, 'INSERT INTO employees (id, salary) VALUES (1, 75000);');
      const result = executeSQLPlus(session, 'UPDATE employees SET salary = 80000 WHERE id = 1;');
      expect(result.error).toBeUndefined();
    });

    it('deletes data with WHERE', () => {
      executeSQLPlus(session, 'CREATE TABLE employees (id NUMBER, name VARCHAR2(100));');
      executeSQLPlus(session, "INSERT INTO employees (id, name) VALUES (1, 'John');");
      executeSQLPlus(session, "INSERT INTO employees (id, name) VALUES (2, 'Jane');");
      const result = executeSQLPlus(session, 'DELETE FROM employees WHERE id = 2;');
      expect(result.error).toBeUndefined();
    });
  });

  describe('Transactions from docs/oracle.md', () => {
    it('handles COMMIT', () => {
      executeSQLPlus(session, 'CREATE TABLE test (id NUMBER);');
      executeSQLPlus(session, 'INSERT INTO test VALUES (1);');
      const result = executeSQLPlus(session, 'COMMIT;');
      expect(result.error).toBeUndefined();
    });

    it('handles ROLLBACK', () => {
      executeSQLPlus(session, 'CREATE TABLE test (id NUMBER);');
      executeSQLPlus(session, 'INSERT INTO test VALUES (1);');
      const result = executeSQLPlus(session, 'ROLLBACK;');
      expect(result.error).toBeUndefined();
    });
  });
});

// ============================================
// SQL Engine Integration Tests
// ============================================
describe('SQL Engine Integration Tests', () => {
  let engine: SQLEngine;

  beforeEach(() => {
    engine = new SQLEngine();
  });

  describe('Complete Schema Creation (from docs)', () => {
    it('creates departments and employees tables with foreign key', () => {
      // Create departments table
      const deptResult = parseSQL(`
        CREATE TABLE departments (
          dept_id INTEGER PRIMARY KEY,
          dept_name VARCHAR(50) NOT NULL,
          location VARCHAR(100)
        );
      `);
      expect(deptResult.success).toBe(true);
      const deptExec = engine.createTable(deptResult.statements[0] as any);
      expect(deptExec.success).toBe(true);

      // Create employees table with foreign key reference
      const empResult = parseSQL(`
        CREATE TABLE employees (
          emp_id INTEGER PRIMARY KEY,
          first_name VARCHAR(50),
          last_name VARCHAR(50),
          email VARCHAR(100) UNIQUE,
          dept_id INTEGER,
          salary NUMERIC(10,2),
          hire_date DATE
        );
      `);
      expect(empResult.success).toBe(true);
      const empExec = engine.createTable(empResult.statements[0] as any);
      expect(empExec.success).toBe(true);
    });

    it('inserts data into departments and employees', () => {
      // Setup tables
      const dept = parseSQL('CREATE TABLE departments (dept_id INTEGER PRIMARY KEY, dept_name VARCHAR(50), location VARCHAR(100));');
      engine.createTable(dept.statements[0] as any);

      const emp = parseSQL('CREATE TABLE employees (emp_id INTEGER PRIMARY KEY, first_name VARCHAR(50), last_name VARCHAR(50), dept_id INTEGER, salary NUMERIC(10,2));');
      engine.createTable(emp.statements[0] as any);

      // Insert departments
      const insertDept = parseSQL(`
        INSERT INTO departments (dept_id, dept_name, location) VALUES
          (1, 'IT', 'Building A'),
          (2, 'HR', 'Building B'),
          (3, 'Sales', 'Building C');
      `);
      expect(insertDept.success).toBe(true);
      const deptExec = engine.executeInsert(insertDept.statements[0] as any);
      expect(deptExec.success).toBe(true);
      expect(deptExec.affectedRows).toBe(3);

      // Insert employees
      const insertEmp = parseSQL(`
        INSERT INTO employees (emp_id, first_name, last_name, dept_id, salary) VALUES
          (1, 'John', 'Doe', 1, 75000),
          (2, 'Jane', 'Smith', 2, 65000),
          (3, 'Bob', 'Johnson', 1, 80000);
      `);
      expect(insertEmp.success).toBe(true);
      const empExec = engine.executeInsert(insertEmp.statements[0] as any);
      expect(empExec.success).toBe(true);
      expect(empExec.affectedRows).toBe(3);
    });
  });

  describe('Complex Queries from docs', () => {
    beforeEach(() => {
      // Setup test data
      const dept = parseSQL('CREATE TABLE departments (dept_id INTEGER PRIMARY KEY, dept_name VARCHAR(50));');
      engine.createTable(dept.statements[0] as any);

      const emp = parseSQL('CREATE TABLE employees (emp_id INTEGER PRIMARY KEY, first_name VARCHAR(50), last_name VARCHAR(50), dept_id INTEGER, salary NUMERIC(10,2));');
      engine.createTable(emp.statements[0] as any);

      const insertDept = parseSQL("INSERT INTO departments (dept_id, dept_name) VALUES (1, 'IT'), (2, 'HR'), (3, 'Sales');");
      engine.executeInsert(insertDept.statements[0] as any);

      const insertEmp = parseSQL("INSERT INTO employees (emp_id, first_name, last_name, dept_id, salary) VALUES (1, 'John', 'Doe', 1, 75000), (2, 'Jane', 'Smith', 2, 65000), (3, 'Bob', 'Johnson', 1, 80000), (4, 'Alice', 'Brown', 3, 70000);");
      engine.executeInsert(insertEmp.statements[0] as any);
    });

    it('performs INNER JOIN', () => {
      const result = parseSQL(`
        SELECT e.first_name, e.last_name, d.dept_name, e.salary
        FROM employees e
        INNER JOIN departments d ON e.dept_id = d.dept_id
        ORDER BY e.salary DESC;
      `);
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(4);
    });

    it('performs GROUP BY with aggregation', () => {
      const result = parseSQL(`
        SELECT dept_id, COUNT(*) as emp_count
        FROM employees
        GROUP BY dept_id;
      `);
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('performs GROUP BY with HAVING', () => {
      const result = parseSQL(`
        SELECT dept_id, COUNT(*) as emp_count
        FROM employees
        GROUP BY dept_id
        HAVING COUNT(*) > 1;
      `);
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('performs ORDER BY DESC', () => {
      const result = parseSQL('SELECT * FROM employees ORDER BY salary DESC;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      // First row should have highest salary (80000)
      if (execResult.resultSet && execResult.resultSet.rows.length > 0) {
        const firstRow = execResult.resultSet.rows[0];
        expect(firstRow['salary'] || firstRow['SALARY']).toBe(80000);
      }
    });

    it('performs LIMIT and OFFSET', () => {
      const result = parseSQL('SELECT * FROM employees LIMIT 2 OFFSET 1;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(2);
    });

    it('performs SELECT DISTINCT', () => {
      const result = parseSQL('SELECT DISTINCT dept_id FROM employees;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(3);
    });
  });

  describe('Aggregate Functions', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE sales (id INTEGER, amount NUMERIC(10,2), category VARCHAR(50));');
      engine.createTable(create.statements[0] as any);

      const insert = parseSQL("INSERT INTO sales (id, amount, category) VALUES (1, 100, 'A'), (2, 200, 'A'), (3, 150, 'B'), (4, 300, 'A'), (5, 250, 'B');");
      engine.executeInsert(insert.statements[0] as any);
    });

    it('calculates COUNT', () => {
      const result = parseSQL('SELECT COUNT(*) as total FROM sales;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('calculates SUM', () => {
      const result = parseSQL('SELECT SUM(amount) as total_amount FROM sales;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('calculates AVG', () => {
      const result = parseSQL('SELECT AVG(amount) as avg_amount FROM sales;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('calculates MIN and MAX', () => {
      const result = parseSQL('SELECT MIN(amount) as min_amt, MAX(amount) as max_amt FROM sales;');
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('performs GROUP BY with multiple aggregates', () => {
      const result = parseSQL(`
        SELECT category, COUNT(*) as cnt, SUM(amount) as total, AVG(amount) as avg
        FROM sales
        GROUP BY category;
      `);
      expect(result.success).toBe(true);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(2);
    });
  });

  describe('Data Modification Scenarios', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE inventory (id INTEGER PRIMARY KEY, product VARCHAR(100), quantity INTEGER, price NUMERIC(10,2));');
      engine.createTable(create.statements[0] as any);

      const insert = parseSQL("INSERT INTO inventory (id, product, quantity, price) VALUES (1, 'Widget', 100, 9.99), (2, 'Gadget', 50, 19.99), (3, 'Gizmo', 75, 14.99);");
      engine.executeInsert(insert.statements[0] as any);
    });

    it('updates multiple rows', () => {
      const update = parseSQL('UPDATE inventory SET price = price * 1.1;');
      expect(update.success).toBe(true);
      const execResult = engine.executeUpdate(update.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(3);
    });

    it('updates with complex WHERE', () => {
      const update = parseSQL('UPDATE inventory SET quantity = quantity - 10 WHERE price > 10;');
      expect(update.success).toBe(true);
      const execResult = engine.executeUpdate(update.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(2);
    });

    it('deletes with WHERE', () => {
      const del = parseSQL('DELETE FROM inventory WHERE quantity < 60;');
      expect(del.success).toBe(true);
      const execResult = engine.executeDelete(del.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(1);
    });
  });

  describe('Transaction Support', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance NUMERIC(10,2));');
      engine.createTable(create.statements[0] as any);

      const insert = parseSQL('INSERT INTO accounts (id, balance) VALUES (1, 1000), (2, 500);');
      engine.executeInsert(insert.statements[0] as any);
    });

    it('begins transaction', () => {
      const result = engine.beginTransaction();
      expect(result.success).toBe(true);
    });

    it('commits transaction', () => {
      engine.beginTransaction();
      const update = parseSQL('UPDATE accounts SET balance = balance - 100 WHERE id = 1;');
      engine.executeUpdate(update.statements[0] as any);
      const result = engine.commit();
      expect(result.success).toBe(true);
    });

    it('rolls back transaction', () => {
      engine.beginTransaction();
      const update = parseSQL('UPDATE accounts SET balance = balance - 100 WHERE id = 1;');
      engine.executeUpdate(update.statements[0] as any);
      const result = engine.rollback();
      expect(result.success).toBe(true);
    });
  });

  describe('DROP TABLE scenarios', () => {
    beforeEach(() => {
      const create = parseSQL('CREATE TABLE temp_table (id INTEGER);');
      engine.createTable(create.statements[0] as any);
    });

    it('drops existing table', () => {
      const result = engine.dropTable('temp_table');
      expect(result.success).toBe(true);
    });

    it('fails to drop non-existent table', () => {
      const result = engine.dropTable('nonexistent');
      expect(result.success).toBe(false);
    });

    it('succeeds with IF EXISTS on non-existent table', () => {
      const result = engine.dropTable('nonexistent', undefined, true);
      expect(result.success).toBe(true);
    });
  });
});

// ============================================
// SQL Parser Edge Cases
// ============================================
describe('SQL Parser Edge Cases', () => {
  describe('Complex WHERE clauses', () => {
    it('parses AND condition', () => {
      const result = parseSQL('SELECT * FROM users WHERE age > 18 AND status = 1;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.where).toBeDefined();
    });

    it('parses OR condition', () => {
      const result = parseSQL("SELECT * FROM users WHERE status = 'active' OR status = 'pending';");
      expect(result.success).toBe(true);
    });

    it('parses IN clause', () => {
      const result = parseSQL('SELECT * FROM users WHERE id IN (1, 2, 3);');
      expect(result.success).toBe(true);
    });

    it('parses BETWEEN clause', () => {
      const result = parseSQL('SELECT * FROM users WHERE age BETWEEN 18 AND 65;');
      expect(result.success).toBe(true);
    });

    it('parses LIKE clause', () => {
      const result = parseSQL("SELECT * FROM users WHERE name LIKE '%John%';");
      expect(result.success).toBe(true);
    });

    it('parses IS NULL', () => {
      const result = parseSQL('SELECT * FROM users WHERE email IS NULL;');
      expect(result.success).toBe(true);
    });

    it('parses IS NOT NULL', () => {
      const result = parseSQL('SELECT * FROM users WHERE email IS NOT NULL;');
      expect(result.success).toBe(true);
    });

    it('parses parenthesized conditions', () => {
      const result = parseSQL("SELECT * FROM users WHERE (age > 18 AND status = 'active') OR is_admin = 1;");
      expect(result.success).toBe(true);
    });
  });

  describe('Complex SELECT features', () => {
    it('parses column aliases', () => {
      const result = parseSQL('SELECT name AS full_name, age AS years FROM users;');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].alias).toBe('full_name');
    });

    it('parses table aliases', () => {
      const result = parseSQL('SELECT u.name, u.age FROM users u;');
      expect(result.success).toBe(true);
    });

    it('parses multiple JOINs', () => {
      const result = parseSQL(`
        SELECT u.name, o.total, p.name
        FROM users u
        JOIN orders o ON u.id = o.user_id
        JOIN products p ON o.product_id = p.id;
      `);
      expect(result.success).toBe(true);
    });

    it('parses LEFT JOIN', () => {
      const result = parseSQL('SELECT * FROM users u LEFT JOIN orders o ON u.id = o.user_id;');
      expect(result.success).toBe(true);
    });

    it('parses RIGHT JOIN', () => {
      const result = parseSQL('SELECT * FROM users u RIGHT JOIN orders o ON u.id = o.user_id;');
      expect(result.success).toBe(true);
    });

    it('parses FULL OUTER JOIN', () => {
      const result = parseSQL('SELECT * FROM users u FULL OUTER JOIN orders o ON u.id = o.user_id;');
      expect(result.success).toBe(true);
    });
  });

  describe('Data Type Parsing', () => {
    it('parses INTEGER', () => {
      const result = parseSQL('CREATE TABLE t (col INTEGER);');
      expect(result.success).toBe(true);
    });

    it('parses VARCHAR with length', () => {
      const result = parseSQL('CREATE TABLE t (col VARCHAR(255));');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].length).toBe(255);
    });

    it('parses NUMERIC with precision and scale', () => {
      const result = parseSQL('CREATE TABLE t (col NUMERIC(10,2));');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].precision).toBe(10);
      expect(stmt.columns[0].scale).toBe(2);
    });

    it('parses BOOLEAN', () => {
      const result = parseSQL('CREATE TABLE t (col BOOLEAN);');
      expect(result.success).toBe(true);
    });

    it('parses DATE', () => {
      const result = parseSQL('CREATE TABLE t (col DATE);');
      expect(result.success).toBe(true);
    });

    it('parses TIMESTAMP', () => {
      const result = parseSQL('CREATE TABLE t (col TIMESTAMP);');
      expect(result.success).toBe(true);
    });

    it('parses TEXT', () => {
      const result = parseSQL('CREATE TABLE t (col TEXT);');
      expect(result.success).toBe(true);
    });
  });

  describe('Constraint Parsing', () => {
    it('parses PRIMARY KEY', () => {
      const result = parseSQL('CREATE TABLE t (id INTEGER PRIMARY KEY);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].primaryKey).toBe(true);
    });

    it('parses NOT NULL', () => {
      const result = parseSQL('CREATE TABLE t (name VARCHAR(100) NOT NULL);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].nullable).toBe(false);
    });

    it('parses UNIQUE', () => {
      const result = parseSQL('CREATE TABLE t (email VARCHAR(100) UNIQUE);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].unique).toBe(true);
    });

    it('parses DEFAULT with string', () => {
      const result = parseSQL("CREATE TABLE t (status VARCHAR(20) DEFAULT 'active');");
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].defaultValue).toBe('active');
    });

    it('parses DEFAULT with number', () => {
      const result = parseSQL('CREATE TABLE t (count INTEGER DEFAULT 0);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].defaultValue).toBe(0);
    });

    it('parses multiple constraints on one column', () => {
      const result = parseSQL('CREATE TABLE t (id INTEGER PRIMARY KEY NOT NULL);');
      expect(result.success).toBe(true);
      const stmt = result.statements[0] as any;
      expect(stmt.columns[0].primaryKey).toBe(true);
      expect(stmt.columns[0].nullable).toBe(false);
    });
  });
});

// ============================================
// Real-World Usage Scenarios
// ============================================
describe('Real-World Usage Scenarios', () => {
  let engine: SQLEngine;

  beforeEach(() => {
    engine = new SQLEngine();
  });

  describe('E-commerce Database', () => {
    beforeEach(() => {
      // Create tables
      engine.createTable(parseSQL('CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE);').statements[0] as any);
      engine.createTable(parseSQL('CREATE TABLE products (id INTEGER PRIMARY KEY, name VARCHAR(100), price NUMERIC(10,2), stock INTEGER);').statements[0] as any);
      engine.createTable(parseSQL('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total NUMERIC(10,2), status VARCHAR(20));').statements[0] as any);

      // Insert data
      engine.executeInsert(parseSQL("INSERT INTO customers (id, name, email) VALUES (1, 'Alice', 'alice@example.com'), (2, 'Bob', 'bob@example.com');").statements[0] as any);
      engine.executeInsert(parseSQL("INSERT INTO products (id, name, price, stock) VALUES (1, 'Widget', 29.99, 100), (2, 'Gadget', 49.99, 50), (3, 'Gizmo', 19.99, 200);").statements[0] as any);
      engine.executeInsert(parseSQL("INSERT INTO orders (id, customer_id, total, status) VALUES (1, 1, 79.98, 'completed'), (2, 1, 49.99, 'pending'), (3, 2, 29.99, 'completed');").statements[0] as any);
    });

    it('finds customers with orders', () => {
      const result = parseSQL(`
        SELECT DISTINCT c.name
        FROM customers c
        JOIN orders o ON c.id = o.customer_id;
      `);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('calculates total sales per customer', () => {
      const result = parseSQL(`
        SELECT c.name, SUM(o.total) as total_spent
        FROM customers c
        JOIN orders o ON c.id = o.customer_id
        GROUP BY c.name;
      `);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('finds completed orders', () => {
      const result = parseSQL("SELECT * FROM orders WHERE status = 'completed';");
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.resultSet?.rows.length).toBe(2);
    });

    it('updates stock after sale', () => {
      const result = parseSQL('UPDATE products SET stock = stock - 1 WHERE id = 1;');
      const execResult = engine.executeUpdate(result.statements[0] as any);
      expect(execResult.success).toBe(true);

      // Verify stock was updated
      const select = parseSQL('SELECT stock FROM products WHERE id = 1;');
      const selectResult = engine.executeSelect(select.statements[0] as any);
      expect(selectResult.success).toBe(true);
      if (selectResult.resultSet && selectResult.resultSet.rows.length > 0) {
        const stock = selectResult.resultSet.rows[0]['stock'] || selectResult.resultSet.rows[0]['STOCK'];
        expect(stock).toBe(99);
      }
    });
  });

  describe('Employee Management', () => {
    beforeEach(() => {
      engine.createTable(parseSQL('CREATE TABLE departments (id INTEGER PRIMARY KEY, name VARCHAR(50));').statements[0] as any);
      engine.createTable(parseSQL('CREATE TABLE employees (id INTEGER PRIMARY KEY, name VARCHAR(100), dept_id INTEGER, salary NUMERIC(10,2), hire_date DATE);').statements[0] as any);

      engine.executeInsert(parseSQL("INSERT INTO departments (id, name) VALUES (1, 'Engineering'), (2, 'Sales'), (3, 'HR');").statements[0] as any);
      engine.executeInsert(parseSQL("INSERT INTO employees (id, name, dept_id, salary) VALUES (1, 'John', 1, 80000), (2, 'Jane', 1, 90000), (3, 'Bob', 2, 70000), (4, 'Alice', 3, 60000);").statements[0] as any);
    });

    it('calculates average salary by department', () => {
      const result = parseSQL(`
        SELECT d.name, AVG(e.salary) as avg_salary
        FROM departments d
        JOIN employees e ON d.id = e.dept_id
        GROUP BY d.name;
      `);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('finds highest paid employee per department', () => {
      const result = parseSQL(`
        SELECT d.name, MAX(e.salary) as max_salary
        FROM departments d
        JOIN employees e ON d.id = e.dept_id
        GROUP BY d.name;
      `);
      const execResult = engine.executeSelect(result.statements[0] as any);
      expect(execResult.success).toBe(true);
    });

    it('gives everyone a 10% raise', () => {
      const result = parseSQL('UPDATE employees SET salary = salary * 1.1;');
      const execResult = engine.executeUpdate(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(4);
    });

    it('fires employees in HR', () => {
      const result = parseSQL('DELETE FROM employees WHERE dept_id = 3;');
      const execResult = engine.executeDelete(result.statements[0] as any);
      expect(execResult.success).toBe(true);
      expect(execResult.affectedRows).toBe(1);
    });
  });
});

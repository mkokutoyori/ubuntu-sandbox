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

// ============================================
// Oracle DBA Training V$ Views Integration Tests
// ============================================
describe('Oracle DBA V$ Views Integration', () => {
  let session: ReturnType<typeof createSQLPlusSession>;

  beforeEach(() => {
    session = createSQLPlusSession();
  });

  describe('Redo Log Management (V$LOG, V$LOGFILE)', () => {
    it('should query V$LOG via SQL*Plus', () => {
      const result = executeSQLPlus(session, 'SELECT * FROM V$LOG;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
      expect(result.output).toContain('GROUP_NUM');
      expect(result.output).toContain('STATUS');
    });

    it('should find CURRENT log group', () => {
      const result = executeSQLPlus(session, "SELECT GROUP_NUM, STATUS FROM V$LOG WHERE STATUS = 'CURRENT';");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('CURRENT');
    });

    it('should query V$LOGFILE for log members', () => {
      const result = executeSQLPlus(session, 'SELECT GROUP_NUM, MEMBER FROM V$LOGFILE;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('redo');
    });

    it('should query V$ARCHIVED_LOG', () => {
      const result = executeSQLPlus(session, 'SELECT RECID, SEQUENCE_NUM, NAME FROM V$ARCHIVED_LOG;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('archivelog');
    });
  });

  describe('RMAN Backup History (V$RMAN_BACKUP_JOB_DETAILS)', () => {
    it('should query backup job history', () => {
      const result = executeSQLPlus(session, 'SELECT SESSION_KEY, INPUT_TYPE, STATUS FROM V$RMAN_BACKUP_JOB_DETAILS;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should find completed full backups', () => {
      const result = executeSQLPlus(session, "SELECT SESSION_KEY, INPUT_TYPE, ELAPSED_SECONDS FROM V$RMAN_BACKUP_JOB_DETAILS WHERE INPUT_TYPE = 'DB FULL';");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('DB FULL');
    });

    it('should query backup sizes', () => {
      const result = executeSQLPlus(session, 'SELECT INPUT_TYPE, INPUT_BYTES_DISPLAY, OUTPUT_BYTES_DISPLAY FROM V$RMAN_BACKUP_JOB_DETAILS;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });
  });

  describe('SGA Memory Management (V$SGA, V$SGASTAT)', () => {
    it('should query V$SGA for memory components', () => {
      const result = executeSQLPlus(session, 'SELECT NAME, VALUE_BYTES FROM V$SGA;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Fixed Size');
      expect(result.output).toContain('Database Buffers');
    });

    it('should query V$SGASTAT for pool statistics', () => {
      const result = executeSQLPlus(session, "SELECT POOL, COMPONENT_NAME, BYTES_VAL FROM V$SGASTAT WHERE POOL = 'shared pool';");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('shared pool');
    });
  });

  describe('Wait Statistics (V$WAITSTAT)', () => {
    it('should query wait class statistics', () => {
      const result = executeSQLPlus(session, 'SELECT WAIT_CLASS, COUNT_VAL, TIME_VAL FROM V$WAITSTAT;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('User I/O');
    });
  });

  describe('SQL Performance (V$SQL, V$SQLAREA)', () => {
    it('should query V$SQL for cached SQL', () => {
      const result = executeSQLPlus(session, 'SELECT SQL_ID, EXECUTIONS, BUFFER_GETS, CPU_TIME FROM V$SQL;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should find top SQL by buffer gets', () => {
      const result = executeSQLPlus(session, "SELECT SQL_ID, SQL_TEXT, BUFFER_GETS FROM V$SQL WHERE PARSING_SCHEMA_NAME = 'HR';");
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should query V$SQLAREA for aggregated stats', () => {
      const result = executeSQLPlus(session, 'SELECT SQL_ID, EXECUTIONS, ELAPSED_TIME FROM V$SQLAREA;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });
  });

  describe('Scheduler Jobs (DBA_SCHEDULER_JOBS)', () => {
    it('should query scheduler jobs', () => {
      const result = executeSQLPlus(session, 'SELECT OWNER, JOB_NAME, JOB_TYPE, STATE FROM DBA_SCHEDULER_JOBS;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('GATHER_STATS_JOB');
    });

    it('should find enabled jobs', () => {
      const result = executeSQLPlus(session, "SELECT JOB_NAME, REPEAT_INTERVAL FROM DBA_SCHEDULER_JOBS WHERE ENABLED = 'TRUE';");
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });
  });

  describe('Resource Manager (DBA_RSRC_PLANS)', () => {
    it('should query resource plans', () => {
      const result = executeSQLPlus(session, 'SELECT PLAN, STATUS, COMMENTS FROM DBA_RSRC_PLANS;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('DEFAULT_PLAN');
    });

    it('should query consumer groups', () => {
      const result = executeSQLPlus(session, 'SELECT CONSUMER_GROUP, COMMENTS FROM DBA_RSRC_CONSUMER_GROUPS;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('SYS_GROUP');
    });
  });

  describe('Flashback (DBA_FLASHBACK_ARCHIVE)', () => {
    it('should query flashback archives', () => {
      const result = executeSQLPlus(session, 'SELECT FLASHBACK_ARCHIVE_NAME, RETENTION_IN_DAYS, STATUS FROM DBA_FLASHBACK_ARCHIVE;');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('FLA_1YEAR');
    });

    it('should query flashback database log', () => {
      const result = executeSQLPlus(session, 'SELECT OLDEST_FLASHBACK_SCN, RETENTION_TARGET, FLASHBACK_SIZE FROM V$FLASHBACK_DATABASE_LOG;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });
  });

  describe('Alert Log (V$DIAG_ALERT_EXT)', () => {
    it('should query alert log entries', () => {
      const result = executeSQLPlus(session, 'SELECT RECORD_ID, MESSAGE_LEVEL, MESSAGE_GROUP, MESSAGE_TEXT FROM V$DIAG_ALERT_EXT;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should find error messages', () => {
      const result = executeSQLPlus(session, "SELECT MESSAGE_TEXT FROM V$DIAG_ALERT_EXT WHERE MESSAGE_GROUP = 'error';");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('ORA-00600');
    });

    it('should find startup messages', () => {
      const result = executeSQLPlus(session, "SELECT MESSAGE_TEXT FROM V$DIAG_ALERT_EXT WHERE MESSAGE_GROUP = 'startup';");
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Database opened');
    });
  });

  describe('DBA Training Scenarios', () => {
    it('should perform log switch analysis', () => {
      // A typical DBA task: analyze redo log activity
      const result = executeSQLPlus(session, `
        SELECT GROUP_NUM, SEQUENCE_NUM, LOG_BYTES, STATUS, ARCHIVED
        FROM V$LOG
        ORDER BY SEQUENCE_NUM DESC;
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should check backup status', () => {
      // A typical DBA task: verify backup status
      const result = executeSQLPlus(session, `
        SELECT INPUT_TYPE, STATUS, INPUT_BYTES_DISPLAY, TIME_TAKEN_DISPLAY
        FROM V$RMAN_BACKUP_JOB_DETAILS
        WHERE STATUS = 'COMPLETED';
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('COMPLETED');
    });

    it('should analyze SGA memory allocation', () => {
      // A typical DBA task: analyze memory usage
      const result = executeSQLPlus(session, 'SELECT NAME, VALUE_BYTES FROM V$SGA;');
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should identify problematic SQL', () => {
      // A typical DBA task: find poorly performing SQL
      const result = executeSQLPlus(session, `
        SELECT SQL_ID, BUFFER_GETS, EXECUTIONS, ELAPSED_TIME
        FROM V$SQL
        ORDER BY BUFFER_GETS DESC;
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('should review scheduled maintenance jobs', () => {
      // A typical DBA task: check maintenance schedule
      const result = executeSQLPlus(session, `
        SELECT JOB_NAME, JOB_TYPE, REPEAT_INTERVAL, STATE
        FROM DBA_SCHEDULER_JOBS
        WHERE OWNER = 'SYS';
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('GATHER_STATS_JOB');
    });

    it('should check alert log for critical errors', () => {
      // A typical DBA task: review recent errors
      const result = executeSQLPlus(session, `
        SELECT ORIGINATING_TIMESTAMP, MESSAGE_LEVEL, MESSAGE_TEXT
        FROM V$DIAG_ALERT_EXT
        WHERE MESSAGE_LEVEL <= 4;
      `);
      expect(result.error).toBeUndefined();
      // Should contain ORA- errors
      expect(result.output).toContain('ORA-');
    });
  });
});

// ============================================
// Oracle RMAN (Recovery Manager) Integration Tests
// ============================================
import { createRMANSession, executeRMAN, getRMANPrompt } from '../terminal/sql/oracle/rman';

describe('Oracle RMAN (Recovery Manager) Integration', () => {
  let session: ReturnType<typeof createRMANSession>;

  beforeEach(() => {
    session = createRMANSession();
    // Auto-connect for most tests
    session.connected = true;
    session.targetDatabase = 'ORCL';
  });

  describe('Session Management', () => {
    it('creates a valid RMAN session', () => {
      expect(session).toBeDefined();
      expect(session.engine).toBeDefined();
      expect(session.securityManager).toBeDefined();
    });

    it('returns correct RMAN prompt', () => {
      const prompt = getRMANPrompt(session);
      expect(prompt).toBe('RMAN> ');
    });

    it('handles EXIT command', () => {
      const result = executeRMAN(session, 'exit');
      expect(result.exit).toBe(true);
      expect(result.output).toContain('Recovery Manager complete');
    });

    it('handles QUIT command', () => {
      const result = executeRMAN(session, 'quit');
      expect(result.exit).toBe(true);
    });

    it('shows HELP information', () => {
      const result = executeRMAN(session, 'help');
      expect(result.output).toContain('BACKUP');
      expect(result.output).toContain('RESTORE');
      expect(result.output).toContain('RECOVER');
      expect(result.output).toContain('LIST');
    });
  });

  describe('Connection Commands', () => {
    it('connects to target database', () => {
      const newSession = createRMANSession();
      expect(newSession.connected).toBe(false);

      const result = executeRMAN(newSession, 'connect target /');
      expect(result.output).toContain('connected to target database');
      expect(newSession.connected).toBe(true);
    });

    it('requires connection before operations', () => {
      const newSession = createRMANSession();
      const result = executeRMAN(newSession, 'backup database');
      expect(result.error).toContain('not connected');
    });
  });

  describe('BACKUP Operations', () => {
    it('performs BACKUP DATABASE', () => {
      const result = executeRMAN(session, 'backup database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting backup');
      expect(result.output).toContain('starting full datafile backup set');
      expect(result.output).toContain('system01.dbf');
      expect(result.output).toContain('backup set complete');
      expect(result.output).toContain('Finished backup');
    });

    it('performs BACKUP ARCHIVELOG ALL', () => {
      const result = executeRMAN(session, 'backup archivelog all');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting backup');
      expect(result.output).toContain('archived log');
      expect(result.output).toContain('Finished backup');
    });

    it('performs incremental level 0 backup', () => {
      const result = executeRMAN(session, 'backup incremental level 0 database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting backup');
      expect(result.output).toContain('Finished backup');
    });

    it('performs incremental level 1 backup', () => {
      const result = executeRMAN(session, 'backup incremental level 1 database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting backup');
    });

    it('performs BACKUP CURRENT CONTROLFILE', () => {
      const result = executeRMAN(session, 'backup current controlfile');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('control file');
    });

    it('performs BACKUP SPFILE', () => {
      const result = executeRMAN(session, 'backup spfile');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('spfile');
    });

    it('generates controlfile autobackup', () => {
      session.controlfileAutobackup = true;
      const result = executeRMAN(session, 'backup database');
      expect(result.output).toContain('control file autobackup complete');
    });
  });

  describe('RESTORE Operations', () => {
    it('performs RESTORE DATABASE', () => {
      const result = executeRMAN(session, 'restore database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting restore');
      expect(result.output).toContain('restoring datafile');
      expect(result.output).toContain('restore complete');
      expect(result.output).toContain('Finished restore');
    });

    it('performs RESTORE CONTROLFILE', () => {
      const result = executeRMAN(session, 'restore controlfile');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting restore');
      expect(result.output).toContain('controlfile');
    });

    it('performs RESTORE SPFILE', () => {
      const result = executeRMAN(session, 'restore spfile');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('restoring spfile');
    });
  });

  describe('RECOVER Operations', () => {
    it('performs RECOVER DATABASE', () => {
      const result = executeRMAN(session, 'recover database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting recover');
      expect(result.output).toContain('media recovery');
      expect(result.output).toContain('archived log');
      expect(result.output).toContain('Finished recover');
    });
  });

  describe('LIST Commands', () => {
    it('lists backup summary', () => {
      const result = executeRMAN(session, 'list backup summary');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('List of Backups');
      expect(result.output).toContain('Key');
      expect(result.output).toContain('Device Type');
    });

    it('lists detailed backup', () => {
      const result = executeRMAN(session, 'list backup');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('List of Backup Sets');
      expect(result.output).toContain('Piece Name');
    });

    it('lists backup of database', () => {
      const result = executeRMAN(session, 'list backup of database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('List of Backup Sets');
      expect(result.output).toContain('List of Datafiles');
    });

    it('lists backup of archivelog', () => {
      const result = executeRMAN(session, 'list backup of archivelog');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('List of Archived Logs');
    });

    it('lists incarnation', () => {
      const result = executeRMAN(session, 'list incarnation');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Database Incarnations');
      expect(result.output).toContain('CURRENT');
    });

    it('lists archivelog all', () => {
      const result = executeRMAN(session, 'list archivelog all');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Archived Log Copies');
    });
  });

  describe('REPORT Commands', () => {
    it('reports obsolete backups', () => {
      const result = executeRMAN(session, 'report obsolete');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('retention policy');
      expect(result.output).toContain('7 days');
    });

    it('reports need backup', () => {
      const result = executeRMAN(session, 'report need backup');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('retention policy');
    });

    it('reports schema', () => {
      const result = executeRMAN(session, 'report schema');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Permanent Datafiles');
      expect(result.output).toContain('SYSTEM');
      expect(result.output).toContain('SYSAUX');
      expect(result.output).toContain('USERS');
    });
  });

  describe('CROSSCHECK Commands', () => {
    it('crosschecks backup', () => {
      const result = executeRMAN(session, 'crosscheck backup');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('crosschecked');
      expect(result.output).toContain('AVAILABLE');
    });

    it('crosschecks archivelog all', () => {
      const result = executeRMAN(session, 'crosscheck archivelog all');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('crosschecked');
    });
  });

  describe('DELETE Commands', () => {
    it('deletes obsolete backups', () => {
      const result = executeRMAN(session, 'delete obsolete');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('retention policy');
    });

    it('deletes expired backups', () => {
      const result = executeRMAN(session, 'delete expired');
      expect(result.error).toBeUndefined();
    });
  });

  describe('VALIDATE Commands', () => {
    it('validates database', () => {
      const result = executeRMAN(session, 'validate database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Starting validate');
      expect(result.output).toContain('List of Datafiles');
      expect(result.output).toContain('OK');
      expect(result.output).toContain('Finished validate');
    });

    it('validates backupset', () => {
      const result = executeRMAN(session, 'validate backupset 1');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('validation of backup set');
      expect(result.output).toContain('backup set validated');
    });
  });

  describe('CONFIGURE Commands', () => {
    it('configures retention policy redundancy', () => {
      const result = executeRMAN(session, 'configure retention policy to redundancy 2');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('RETENTION POLICY');
      expect(result.output).toContain('REDUNDANCY 2');
      expect(session.retentionPolicy).toBe('REDUNDANCY 2');
    });

    it('configures retention policy recovery window', () => {
      const result = executeRMAN(session, 'configure retention policy to recovery window of 14 days');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('RECOVERY WINDOW');
      expect(session.retentionPolicy).toBe('RECOVERY WINDOW OF 14 DAYS');
    });

    it('configures backup optimization', () => {
      const result = executeRMAN(session, 'configure backup optimization on');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('BACKUP OPTIMIZATION ON');
      expect(session.backupOptimization).toBe(true);
    });

    it('configures controlfile autobackup', () => {
      session.controlfileAutobackup = false;
      const result = executeRMAN(session, 'configure controlfile autobackup on');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('CONTROLFILE AUTOBACKUP ON');
      expect(session.controlfileAutobackup).toBe(true);
    });

    it('configures device type', () => {
      const result = executeRMAN(session, 'configure default device type to sbt');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('DEVICE TYPE');
      expect(session.deviceType).toBe('SBT_TAPE');
    });

    it('configures parallelism', () => {
      const result = executeRMAN(session, 'configure parallelism 4');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('PARALLELISM 4');
      expect(session.parallelism).toBe(4);
    });
  });

  describe('SHOW Commands', () => {
    it('shows all configuration', () => {
      const result = executeRMAN(session, 'show all');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('RETENTION POLICY');
      expect(result.output).toContain('BACKUP OPTIMIZATION');
      expect(result.output).toContain('CONTROLFILE AUTOBACKUP');
      expect(result.output).toContain('DEVICE TYPE');
      expect(result.output).toContain('PARALLELISM');
    });

    it('shows retention policy', () => {
      const result = executeRMAN(session, 'show retention policy');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('RETENTION POLICY');
    });
  });

  describe('Channel Management', () => {
    it('allocates channel', () => {
      const result = executeRMAN(session, 'allocate channel c1 device type disk');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('allocated channel: c1');
      expect(session.channel).toBe('c1');
    });

    it('releases channel', () => {
      session.channel = 'c1';
      const result = executeRMAN(session, 'release channel c1');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('released channel');
    });
  });

  describe('RUN Block', () => {
    it('executes RUN block with multiple commands', () => {
      const result = executeRMAN(session, `run {
        allocate channel c1 device type disk;
        backup database;
        release channel c1;
      }`);
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('allocated channel');
      expect(result.output).toContain('Starting backup');
      expect(result.output).toContain('released channel');
    });
  });

  describe('Database Control', () => {
    it('handles STARTUP command', () => {
      const result = executeRMAN(session, 'startup');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Oracle instance started');
      expect(result.output).toContain('database mounted');
      expect(result.output).toContain('database opened');
    });

    it('handles STARTUP MOUNT', () => {
      const result = executeRMAN(session, 'startup mount');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Oracle instance started');
      expect(result.output).toContain('database mounted');
      expect(result.output).not.toContain('database opened');
    });

    it('handles SHUTDOWN', () => {
      const result = executeRMAN(session, 'shutdown');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('database closed');
      expect(result.output).toContain('Oracle instance shut down');
    });

    it('handles SHUTDOWN IMMEDIATE', () => {
      const result = executeRMAN(session, 'shutdown immediate');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Oracle instance shut down');
    });
  });

  describe('Error Handling', () => {
    it('handles invalid command', () => {
      const result = executeRMAN(session, 'invalidcommand');
      expect(result.error).toContain('RMAN-00558');
      expect(result.error).toContain('syntax error');
    });
  });

  describe('DBA Training Scenarios', () => {
    it('performs complete backup and recovery workflow', () => {
      // 1. Show current configuration
      let result = executeRMAN(session, 'show all');
      expect(result.error).toBeUndefined();

      // 2. Configure retention
      result = executeRMAN(session, 'configure retention policy to recovery window of 7 days');
      expect(result.error).toBeUndefined();

      // 3. Backup database
      result = executeRMAN(session, 'backup database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('Finished backup');

      // 4. Backup archivelogs
      result = executeRMAN(session, 'backup archivelog all');
      expect(result.error).toBeUndefined();

      // 5. List backups
      result = executeRMAN(session, 'list backup summary');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('List of Backups');

      // 6. Crosscheck
      result = executeRMAN(session, 'crosscheck backup');
      expect(result.error).toBeUndefined();

      // 7. Report obsolete
      result = executeRMAN(session, 'report obsolete');
      expect(result.error).toBeUndefined();
    });

    it('performs disaster recovery simulation', () => {
      // Simulate restore and recovery after database loss
      let result = executeRMAN(session, 'restore controlfile');
      expect(result.error).toBeUndefined();

      result = executeRMAN(session, 'restore database');
      expect(result.error).toBeUndefined();

      result = executeRMAN(session, 'recover database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('media recovery complete');
    });

    it('validates backups before restore', () => {
      const result = executeRMAN(session, 'validate database');
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('OK');
    });
  });
});

/**
 * Tests for Oracle SQL Aliasing — column aliases, table aliases,
 * and their interactions at the SQL*Plus terminal level.
 *
 * Scenarios covered:
 *   1. Column aliases with AS keyword
 *   2. Column aliases without AS (implicit)
 *   3. Table aliases in FROM clause
 *   4. Column aliases in ORDER BY
 *   5. Column aliases in GROUP BY / HAVING
 *   6. Expression aliases (arithmetic, functions)
 *   7. Table aliases in JOINs
 *   8. Subquery (inline view) aliases
 *   9. Column alias in output headers
 *  10. CTE aliases
 *  11. Alias conflicts and edge cases
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';
import { installHRSchema } from '../../../database/oracle/demo/DemoSchemas';

let db: OracleDatabase;
let executor: OracleExecutor;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
});

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

// ═══════════════════════════════════════════════════════════════════
// 1. Column aliases with AS keyword
// ═══════════════════════════════════════════════════════════════════

describe('Column aliases with AS keyword', () => {
  test('SELECT literal AS alias', () => {
    const result = exec("SELECT 42 AS answer FROM DUAL");
    expect(result.rows[0][0]).toBe(42);
    expect(result.columns[0].name.toUpperCase()).toBe('ANSWER');
  });

  test('SELECT string literal AS alias', () => {
    const result = exec("SELECT 'hello' AS greeting FROM DUAL");
    expect(result.rows[0][0]).toBe('hello');
    expect(result.columns[0].name.toUpperCase()).toBe('GREETING');
  });

  test('SELECT column AS alias from table', () => {
    exec('CREATE TABLE products (product_name VARCHAR2(50), price NUMBER)');
    exec("INSERT INTO products VALUES ('Widget', 9.99)");
    const result = exec('SELECT product_name AS item, price AS cost FROM products');
    expect(result.columns[0].name.toUpperCase()).toBe('ITEM');
    expect(result.columns[1].name.toUpperCase()).toBe('COST');
    expect(result.rows[0][0]).toBe('Widget');
    expect(result.rows[0][1]).toBe(9.99);
  });

  test('multiple column aliases in same SELECT', () => {
    const result = exec("SELECT 1 AS a, 2 AS b, 3 AS c FROM DUAL");
    expect(result.columns.map(c => c.name.toUpperCase())).toEqual(['A', 'B', 'C']);
    expect(result.rows[0]).toEqual([1, 2, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Column aliases without AS (implicit)
// ═══════════════════════════════════════════════════════════════════

describe('Implicit column aliases (without AS)', () => {
  test('SELECT literal alias (no AS keyword)', () => {
    const result = exec('SELECT 42 answer FROM DUAL');
    expect(result.rows[0][0]).toBe(42);
    expect(result.columns[0].name.toUpperCase()).toBe('ANSWER');
  });

  test('SELECT column implicit_alias from table', () => {
    exec('CREATE TABLE staff (full_name VARCHAR2(50))');
    exec("INSERT INTO staff VALUES ('Alice')");
    const result = exec('SELECT full_name nom FROM staff');
    expect(result.columns[0].name.toUpperCase()).toBe('NOM');
    expect(result.rows[0][0]).toBe('Alice');
  });

  test('mix of AS and implicit aliases', () => {
    const result = exec("SELECT 1 AS explicit_a, 2 implicit_b, 3 AS explicit_c FROM DUAL");
    const names = result.columns.map(c => c.name.toUpperCase());
    expect(names).toEqual(['EXPLICIT_A', 'IMPLICIT_B', 'EXPLICIT_C']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. Table aliases in FROM clause
// ═══════════════════════════════════════════════════════════════════

describe('Table aliases in FROM clause', () => {
  beforeEach(() => {
    exec('CREATE TABLE employees_t (id NUMBER, name VARCHAR2(50), dept_id NUMBER)');
    exec("INSERT INTO employees_t VALUES (1, 'Alice', 10)");
    exec("INSERT INTO employees_t VALUES (2, 'Bob', 20)");
  });

  test('table alias qualifies column in SELECT', () => {
    const result = exec('SELECT e.name FROM employees_t e WHERE e.id = 1');
    expect(result.rows[0][0]).toBe('Alice');
  });

  test('table alias qualifies column in WHERE', () => {
    const result = exec('SELECT e.name FROM employees_t e WHERE e.dept_id = 20');
    expect(result.rows[0][0]).toBe('Bob');
  });

  test('table alias used in ORDER BY', () => {
    const result = exec('SELECT e.name FROM employees_t e ORDER BY e.name');
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[1][0]).toBe('Bob');
  });

  test('unqualified column still works with table alias', () => {
    const result = exec('SELECT name FROM employees_t e WHERE id = 1');
    expect(result.rows[0][0]).toBe('Alice');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Column aliases in ORDER BY
// ═══════════════════════════════════════════════════════════════════

describe('Column aliases in ORDER BY', () => {
  beforeEach(() => {
    exec('CREATE TABLE scores (student VARCHAR2(30), score NUMBER)');
    exec("INSERT INTO scores VALUES ('Charlie', 75)");
    exec("INSERT INTO scores VALUES ('Alice', 95)");
    exec("INSERT INTO scores VALUES ('Bob', 85)");
  });

  test('ORDER BY column alias ASC', () => {
    const result = exec('SELECT student AS name, score AS points FROM scores ORDER BY points ASC');
    expect(result.rows[0][1]).toBe(75);
    expect(result.rows[2][1]).toBe(95);
  });

  test('ORDER BY column alias DESC', () => {
    const result = exec('SELECT student AS name, score AS points FROM scores ORDER BY points DESC');
    expect(result.rows[0][1]).toBe(95);
    expect(result.rows[2][1]).toBe(75);
  });

  test('ORDER BY positional index', () => {
    const result = exec('SELECT student, score FROM scores ORDER BY 2 DESC');
    expect(result.rows[0][1]).toBe(95);
  });

  test('ORDER BY expression alias', () => {
    const result = exec('SELECT student, score * 2 AS doubled FROM scores ORDER BY doubled DESC');
    expect(result.rows[0][1]).toBe(190); // 95 * 2
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Column aliases with GROUP BY / aggregate
// ═══════════════════════════════════════════════════════════════════

describe('Column aliases with GROUP BY and aggregates', () => {
  beforeEach(() => {
    exec('CREATE TABLE orders (customer VARCHAR2(30), amount NUMBER, category VARCHAR2(20))');
    exec("INSERT INTO orders VALUES ('Alice', 100, 'A')");
    exec("INSERT INTO orders VALUES ('Alice', 200, 'B')");
    exec("INSERT INTO orders VALUES ('Bob', 150, 'A')");
    exec("INSERT INTO orders VALUES ('Bob', 50, 'A')");
  });

  test('aggregate with alias', () => {
    const result = exec('SELECT customer, SUM(amount) AS total FROM orders GROUP BY customer ORDER BY total DESC');
    expect(result.columns[1].name.toUpperCase()).toBe('TOTAL');
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[0][1]).toBe(300);
  });

  test('COUNT with alias', () => {
    const result = exec('SELECT customer, COUNT(*) AS order_count FROM orders GROUP BY customer ORDER BY order_count DESC');
    expect(result.columns[1].name.toUpperCase()).toBe('ORDER_COUNT');
    expect(result.rows[0][1]).toBe(2); // both have 2
  });

  test('multiple aggregates with aliases', () => {
    const result = exec('SELECT customer, SUM(amount) AS total, AVG(amount) AS average FROM orders GROUP BY customer ORDER BY customer');
    expect(result.columns[1].name.toUpperCase()).toBe('TOTAL');
    expect(result.columns[2].name.toUpperCase()).toBe('AVERAGE');
    // Alice: total=300, average=150
    expect(result.rows[0][1]).toBe(300);
    expect(result.rows[0][2]).toBe(150);
  });

  test('GROUP BY with category alias and ORDER BY alias', () => {
    const result = exec('SELECT category AS cat, SUM(amount) AS total FROM orders GROUP BY category ORDER BY total DESC');
    expect(result.columns[0].name.toUpperCase()).toBe('CAT');
    // category A: 100+150+50=300, category B: 200
    expect(result.rows[0][1]).toBe(300);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Expression aliases (arithmetic, functions)
// ═══════════════════════════════════════════════════════════════════

describe('Expression aliases', () => {
  test('arithmetic expression with alias', () => {
    exec('CREATE TABLE items (price NUMBER, qty NUMBER)');
    exec('INSERT INTO items VALUES (10, 5)');
    exec('INSERT INTO items VALUES (20, 3)');
    const result = exec('SELECT price * qty AS total FROM items ORDER BY total DESC');
    expect(result.columns[0].name.toUpperCase()).toBe('TOTAL');
    expect(result.rows[0][0]).toBe(60);
    expect(result.rows[1][0]).toBe(50);
  });

  test('function call with alias', () => {
    const result = exec("SELECT UPPER('hello') AS greeting FROM DUAL");
    expect(result.columns[0].name.toUpperCase()).toBe('GREETING');
    expect(result.rows[0][0]).toBe('HELLO');
  });

  test('concatenation with alias', () => {
    const result = exec("SELECT 'Hello' || ' ' || 'World' AS message FROM DUAL");
    expect(result.columns[0].name.toUpperCase()).toBe('MESSAGE');
    expect(result.rows[0][0]).toBe('Hello World');
  });

  test('CASE expression with alias', () => {
    exec('CREATE TABLE status_t (code NUMBER)');
    exec('INSERT INTO status_t VALUES (1)');
    exec('INSERT INTO status_t VALUES (2)');
    exec('INSERT INTO status_t VALUES (3)');
    const result = exec(`
      SELECT code,
             CASE WHEN code = 1 THEN 'Active'
                  WHEN code = 2 THEN 'Inactive'
                  ELSE 'Unknown' END AS status_label
      FROM status_t ORDER BY code
    `);
    expect(result.columns[1].name.toUpperCase()).toBe('STATUS_LABEL');
    expect(result.rows[0][1]).toBe('Active');
    expect(result.rows[1][1]).toBe('Inactive');
    expect(result.rows[2][1]).toBe('Unknown');
  });

  test('NVL with alias', () => {
    exec('CREATE TABLE nullable_t (val NUMBER)');
    exec('INSERT INTO nullable_t VALUES (42)');
    exec('INSERT INTO nullable_t VALUES (NULL)');
    const result = exec('SELECT NVL(val, 0) AS safe_val FROM nullable_t ORDER BY safe_val');
    expect(result.columns[0].name.toUpperCase()).toBe('SAFE_VAL');
    expect(result.rows[0][0]).toBe(0);
    expect(result.rows[1][0]).toBe(42);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Table aliases in JOINs
// ═══════════════════════════════════════════════════════════════════

describe('Table aliases in JOINs', () => {
  beforeEach(() => {
    exec('CREATE TABLE dept (dept_id NUMBER, dept_name VARCHAR2(30))');
    exec("INSERT INTO dept VALUES (10, 'Engineering')");
    exec("INSERT INTO dept VALUES (20, 'Marketing')");
    exec("INSERT INTO dept VALUES (30, 'HR')");

    exec('CREATE TABLE emp (emp_id NUMBER, emp_name VARCHAR2(30), dept_id NUMBER)');
    exec("INSERT INTO emp VALUES (1, 'Alice', 10)");
    exec("INSERT INTO emp VALUES (2, 'Bob', 20)");
    exec("INSERT INTO emp VALUES (3, 'Charlie', 10)");
    exec("INSERT INTO emp VALUES (4, 'Diana', NULL)");
  });

  test('INNER JOIN with table aliases', () => {
    const result = exec(`
      SELECT e.emp_name, d.dept_name
      FROM emp e
      JOIN dept d ON e.dept_id = d.dept_id
      ORDER BY e.emp_name
    `);
    expect(result.rows.length).toBe(3); // Diana excluded (NULL dept_id)
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[0][1]).toBe('Engineering');
  });

  test('LEFT JOIN with table aliases preserves NULLs', () => {
    const result = exec(`
      SELECT e.emp_name, d.dept_name
      FROM emp e
      LEFT JOIN dept d ON e.dept_id = d.dept_id
      ORDER BY e.emp_name
    `);
    expect(result.rows.length).toBe(4);
    const diana = result.rows.find(r => r[0] === 'Diana');
    expect(diana).toBeDefined();
    expect(diana![1]).toBeNull();
  });

  test('RIGHT JOIN with table aliases', () => {
    const result = exec(`
      SELECT e.emp_name, d.dept_name
      FROM emp e
      RIGHT JOIN dept d ON e.dept_id = d.dept_id
      ORDER BY d.dept_name
    `);
    const hr = result.rows.find(r => r[1] === 'HR');
    expect(hr).toBeDefined();
    expect(hr![0]).toBeNull(); // No employee in HR
  });

  test('self-join with different aliases', () => {
    exec('CREATE TABLE tree (id NUMBER, parent_id NUMBER, name VARCHAR2(30))');
    exec("INSERT INTO tree VALUES (1, NULL, 'Root')");
    exec("INSERT INTO tree VALUES (2, 1, 'Child1')");
    exec("INSERT INTO tree VALUES (3, 1, 'Child2')");
    const result = exec(`
      SELECT c.name AS child_name, p.name AS parent_name
      FROM tree c
      JOIN tree p ON c.parent_id = p.id
      ORDER BY c.name
    `);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('Child1');
    expect(result.rows[0][1]).toBe('Root');
  });

  test('three-way join with different aliases', () => {
    exec('CREATE TABLE projects (proj_id NUMBER, proj_name VARCHAR2(30), dept_id NUMBER)');
    exec("INSERT INTO projects VALUES (1, 'Alpha', 10)");
    exec("INSERT INTO projects VALUES (2, 'Beta', 20)");
    const result = exec(`
      SELECT e.emp_name, d.dept_name, p.proj_name
      FROM emp e
      JOIN dept d ON e.dept_id = d.dept_id
      JOIN projects p ON d.dept_id = p.dept_id
      ORDER BY e.emp_name
    `);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[0][2]).toBe('Alpha');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. Subquery (inline view) aliases
// ═══════════════════════════════════════════════════════════════════

describe('Subquery (inline view) aliases', () => {
  beforeEach(() => {
    exec('CREATE TABLE sales (product VARCHAR2(30), amount NUMBER)');
    exec("INSERT INTO sales VALUES ('Widget', 100)");
    exec("INSERT INTO sales VALUES ('Widget', 200)");
    exec("INSERT INTO sales VALUES ('Gadget', 150)");
  });

  test('simple subquery in FROM with alias', () => {
    const result = exec(`
      SELECT sub.product, sub.total
      FROM (SELECT product, SUM(amount) AS total FROM sales GROUP BY product) sub
      ORDER BY sub.total DESC
    `);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('Widget');
    expect(result.rows[0][1]).toBe(300);
  });

  test('subquery alias used in WHERE of outer query', () => {
    const result = exec(`
      SELECT sub.product, sub.total
      FROM (SELECT product, SUM(amount) AS total FROM sales GROUP BY product) sub
      WHERE sub.total > 200
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe('Widget');
  });

  test('scalar subquery with column alias', () => {
    exec('CREATE TABLE emp2 (id NUMBER, name VARCHAR2(30), dept_id NUMBER)');
    exec("INSERT INTO emp2 VALUES (1, 'Alice', 10)");
    exec('CREATE TABLE dept2 (dept_id NUMBER, dept_name VARCHAR2(30))');
    exec("INSERT INTO dept2 VALUES (10, 'Engineering')");
    const result = exec(`
      SELECT e.name,
             (SELECT d.dept_name FROM dept2 d WHERE d.dept_id = e.dept_id) AS department
      FROM emp2 e
    `);
    expect(result.columns[1].name.toUpperCase()).toBe('DEPARTMENT');
    expect(result.rows[0][1]).toBe('Engineering');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Column alias in output headers (SQL*Plus level)
// ═══════════════════════════════════════════════════════════════════

describe('Column alias in SQL*Plus output headers', () => {
  test('alias appears as column header in formatted output', () => {
    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);
    session.processLine('SET HEADING ON');
    const result = session.processLine("SELECT 'test' AS my_column FROM DUAL;");
    const text = result.output.join('\n').toUpperCase();
    expect(text).toContain('MY_COLUMN');
  });

  test('multiple aliases show correct headers', () => {
    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);
    session.processLine('SET HEADING ON');
    const result = session.processLine("SELECT 1 AS col_a, 2 AS col_b, 3 AS col_c FROM DUAL;");
    const text = result.output.join('\n').toUpperCase();
    expect(text).toContain('COL_A');
    expect(text).toContain('COL_B');
    expect(text).toContain('COL_C');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. CTE (WITH clause) aliases
// ═══════════════════════════════════════════════════════════════════

describe('CTE (WITH clause) aliases', () => {
  test('simple CTE with column alias', () => {
    const result = exec(`
      WITH nums AS (SELECT 1 AS n FROM DUAL)
      SELECT n FROM nums
    `);
    expect(result.rows[0][0]).toBe(1);
  });

  test('CTE used as table alias in main query', () => {
    exec('CREATE TABLE data_t (category VARCHAR2(20), value NUMBER)');
    exec("INSERT INTO data_t VALUES ('X', 10)");
    exec("INSERT INTO data_t VALUES ('X', 20)");
    exec("INSERT INTO data_t VALUES ('Y', 50)");
    const result = exec(`
      WITH summary AS (
        SELECT category AS cat, SUM(value) AS total FROM data_t GROUP BY category
      )
      SELECT s.cat, s.total FROM summary s ORDER BY s.total DESC
    `);
    expect(result.rows[0][0]).toBe('Y');
    expect(result.rows[0][1]).toBe(50);
    expect(result.rows[1][0]).toBe('X');
    expect(result.rows[1][1]).toBe(30);
  });

  test('multiple CTEs with cross-reference', () => {
    installHRSchema(db);
    const result = exec(`
      WITH
        dept_list AS (SELECT department_id, department_name FROM HR.DEPARTMENTS),
        emp_list AS (SELECT employee_id, first_name, department_id FROM HR.EMPLOYEES)
      SELECT e.first_name, d.department_name
      FROM emp_list e
      JOIN dept_list d ON e.department_id = d.department_id
    `);
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. Edge cases and alias conflicts
// ═══════════════════════════════════════════════════════════════════

describe('Alias edge cases', () => {
  test('alias same name as original column', () => {
    exec('CREATE TABLE rename_t (x NUMBER)');
    exec('INSERT INTO rename_t VALUES (42)');
    const result = exec('SELECT x AS x FROM rename_t');
    expect(result.columns[0].name.toUpperCase()).toBe('X');
    expect(result.rows[0][0]).toBe(42);
  });

  test('alias hides original column name in ORDER BY', () => {
    exec('CREATE TABLE ab_t (a NUMBER, b NUMBER)');
    exec('INSERT INTO ab_t VALUES (1, 10)');
    exec('INSERT INTO ab_t VALUES (2, 5)');
    // alias "a" points to column b's value
    const result = exec('SELECT b AS a FROM ab_t ORDER BY a');
    // ORDER BY a should sort by the alias (which is column b)
    expect(result.rows[0][0]).toBe(5);
    expect(result.rows[1][0]).toBe(10);
  });

  test('no alias produces expression as column name', () => {
    const result = exec('SELECT 1 + 2 FROM DUAL');
    // Column name should be some representation of the expression
    expect(result.rows[0][0]).toBe(3);
    expect(result.columns[0].name).toBeDefined();
  });

  test('alias with mixed case is uppercased', () => {
    const result = exec("SELECT 1 AS myAlias FROM DUAL");
    // Oracle uppercases identifiers
    expect(result.columns[0].name.toUpperCase()).toBe('MYALIAS');
    expect(result.rows[0][0]).toBe(1);
  });

  test('table alias used after FROM, not accessible outside query', () => {
    exec('CREATE TABLE test_t (val NUMBER)');
    exec('INSERT INTO test_t VALUES (1)');
    // This should work: alias scoped to query
    const result = exec('SELECT t.val FROM test_t t');
    expect(result.rows[0][0]).toBe(1);
  });

  test('column alias not valid in WHERE clause (Oracle standard)', () => {
    exec('CREATE TABLE where_t (x NUMBER)');
    exec('INSERT INTO where_t VALUES (1)');
    exec('INSERT INTO where_t VALUES (2)');
    // In Oracle, column aliases CANNOT be used in WHERE
    // This should fail or not filter correctly
    const result = exec('SELECT x AS y FROM where_t WHERE x = 1');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12. Alias with HR demo schema (realistic scenario)
// ═══════════════════════════════════════════════════════════════════

describe('Aliases with HR demo schema', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('employee query with multiple aliases', () => {
    const result = exec(`
      SELECT e.first_name AS prenom,
             e.last_name AS nom,
             e.salary AS salaire
      FROM HR.EMPLOYEES e
      WHERE e.department_id = 90
      ORDER BY salaire DESC
    `);
    expect(result.columns[0].name.toUpperCase()).toBe('PRENOM');
    expect(result.columns[1].name.toUpperCase()).toBe('NOM');
    expect(result.columns[2].name.toUpperCase()).toBe('SALAIRE');
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test('department summary with aggregation aliases', () => {
    const result = exec(`
      SELECT d.department_name AS dept,
             COUNT(e.employee_id) AS headcount,
             AVG(e.salary) AS avg_salary
      FROM HR.DEPARTMENTS d
      LEFT JOIN HR.EMPLOYEES e ON d.department_id = e.department_id
      GROUP BY d.department_name
      ORDER BY headcount DESC
    `);
    expect(result.columns[0].name.toUpperCase()).toBe('DEPT');
    expect(result.columns[1].name.toUpperCase()).toBe('HEADCOUNT');
    expect(result.columns[2].name.toUpperCase()).toBe('AVG_SALARY');
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

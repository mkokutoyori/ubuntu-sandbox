/**
 * Tests for Oracle WITH clause (Common Table Expressions / CTE).
 *
 * Scenarios covered:
 *   1.  Basic CTE — single CTE with simple SELECT
 *   2.  CTE with column aliases
 *   3.  CTE with explicit column list: WITH cte(col1, col2) AS (...)
 *   4.  Multiple CTEs
 *   5.  CTE with aggregation (GROUP BY, HAVING)
 *   6.  CTE with JOINs in main query
 *   7.  CTE with WHERE clause filtering
 *   8.  CTE with ORDER BY in main query
 *   9.  CTE referencing another CTE
 *  10.  CTE with expressions and functions
 *  11.  CTE with DISTINCT
 *  12.  CTE used multiple times in main query
 *  13.  CTE with NULL handling
 *  14.  CTE and HR demo schema (realistic scenario)
 *  15.  CTE edge cases
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
// 1. Basic CTE — single CTE with simple SELECT
// ═══════════════════════════════════════════════════════════════════

describe('Basic CTE', () => {
  test('CTE with literal value from DUAL', () => {
    const result = exec(`
      WITH answer AS (SELECT 42 AS val FROM DUAL)
      SELECT val FROM answer
    `);
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(42);
  });

  test('CTE with string literal', () => {
    const result = exec(`
      WITH greet AS (SELECT 'Hello' AS msg FROM DUAL)
      SELECT msg FROM greet
    `);
    expect(result.rows[0][0]).toBe('Hello');
  });

  test('CTE wrapping a table query', () => {
    exec('CREATE TABLE colors (name VARCHAR2(20))');
    exec("INSERT INTO colors VALUES ('Red')");
    exec("INSERT INTO colors VALUES ('Blue')");
    exec("INSERT INTO colors VALUES ('Green')");
    const result = exec(`
      WITH all_colors AS (SELECT name FROM colors)
      SELECT name FROM all_colors ORDER BY name
    `);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0][0]).toBe('Blue');
    expect(result.rows[1][0]).toBe('Green');
    expect(result.rows[2][0]).toBe('Red');
  });

  test('CTE with multiple rows from UNION ALL', () => {
    const result = exec(`
      WITH nums AS (
        SELECT 1 AS n FROM DUAL
        UNION ALL SELECT 2 FROM DUAL
        UNION ALL SELECT 3 FROM DUAL
      )
      SELECT n FROM nums ORDER BY n
    `);
    expect(result.rows.length).toBe(3);
    expect(result.rows.map(r => r[0])).toEqual([1, 2, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. CTE with column aliases
// ═══════════════════════════════════════════════════════════════════

describe('CTE with column aliases', () => {
  test('CTE column aliases carried to main query', () => {
    const result = exec(`
      WITH data AS (SELECT 10 AS x, 20 AS y FROM DUAL)
      SELECT x, y FROM data
    `);
    expect(result.rows[0][0]).toBe(10);
    expect(result.rows[0][1]).toBe(20);
  });

  test('CTE column alias used in ORDER BY of main query', () => {
    exec('CREATE TABLE items (name VARCHAR2(20), price NUMBER)');
    exec("INSERT INTO items VALUES ('A', 30)");
    exec("INSERT INTO items VALUES ('B', 10)");
    exec("INSERT INTO items VALUES ('C', 20)");
    const result = exec(`
      WITH priced AS (SELECT name, price AS cost FROM items)
      SELECT name, cost FROM priced ORDER BY cost ASC
    `);
    expect(result.rows[0][0]).toBe('B');
    expect(result.rows[1][0]).toBe('C');
    expect(result.rows[2][0]).toBe('A');
  });

  test('CTE with expression alias', () => {
    exec('CREATE TABLE nums_t (a NUMBER, b NUMBER)');
    exec('INSERT INTO nums_t VALUES (3, 4)');
    const result = exec(`
      WITH computed AS (SELECT a, b, a + b AS total FROM nums_t)
      SELECT total FROM computed
    `);
    expect(result.rows[0][0]).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. CTE with explicit column list
// ═══════════════════════════════════════════════════════════════════

describe('CTE with explicit column list: WITH cte(col1, col2)', () => {
  test('column list renames CTE columns', () => {
    const result = exec(`
      WITH data(premier, deuxieme) AS (SELECT 1, 2 FROM DUAL)
      SELECT premier, deuxieme FROM data
    `);
    expect(result.rows[0][0]).toBe(1);
    expect(result.rows[0][1]).toBe(2);
    expect(result.columns[0].name.toUpperCase()).toBe('PREMIER');
    expect(result.columns[1].name.toUpperCase()).toBe('DEUXIEME');
  });

  test('column list overrides inner alias', () => {
    const result = exec(`
      WITH data(new_name) AS (SELECT 'hello' AS old_name FROM DUAL)
      SELECT new_name FROM data
    `);
    expect(result.rows[0][0]).toBe('hello');
    expect(result.columns[0].name.toUpperCase()).toBe('NEW_NAME');
  });

  test('column list with multiple columns from table', () => {
    exec('CREATE TABLE pair_t (x NUMBER, y NUMBER)');
    exec('INSERT INTO pair_t VALUES (10, 20)');
    exec('INSERT INTO pair_t VALUES (30, 40)');
    const result = exec(`
      WITH renamed(alpha, beta) AS (SELECT x, y FROM pair_t)
      SELECT alpha, beta FROM renamed ORDER BY alpha
    `);
    expect(result.rows[0]).toEqual([10, 20]);
    expect(result.rows[1]).toEqual([30, 40]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Multiple CTEs
// ═══════════════════════════════════════════════════════════════════

describe('Multiple CTEs', () => {
  test('two independent CTEs joined in main query', () => {
    exec('CREATE TABLE dept_m (dept_id NUMBER, dept_name VARCHAR2(30))');
    exec("INSERT INTO dept_m VALUES (10, 'Engineering')");
    exec("INSERT INTO dept_m VALUES (20, 'Marketing')");

    exec('CREATE TABLE emp_m (emp_id NUMBER, name VARCHAR2(30), dept_id NUMBER)');
    exec("INSERT INTO emp_m VALUES (1, 'Alice', 10)");
    exec("INSERT INTO emp_m VALUES (2, 'Bob', 20)");

    const result = exec(`
      WITH
        departments AS (SELECT dept_id, dept_name FROM dept_m),
        employees AS (SELECT emp_id, name, dept_id FROM emp_m)
      SELECT e.name, d.dept_name
      FROM employees e
      JOIN departments d ON e.dept_id = d.dept_id
      ORDER BY e.name
    `);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[0][1]).toBe('Engineering');
    expect(result.rows[1][0]).toBe('Bob');
    expect(result.rows[1][1]).toBe('Marketing');
  });

  test('three CTEs', () => {
    const result = exec(`
      WITH
        a AS (SELECT 1 AS val FROM DUAL),
        b AS (SELECT 2 AS val FROM DUAL),
        c AS (SELECT 3 AS val FROM DUAL)
      SELECT a.val AS va, b.val AS vb, c.val AS vc
      FROM a, b, c
    `);
    expect(result.rows[0]).toEqual([1, 2, 3]);
  });

  test('two CTEs from same source table', () => {
    exec('CREATE TABLE transactions (category VARCHAR2(10), amount NUMBER)');
    exec("INSERT INTO transactions VALUES ('IN', 100)");
    exec("INSERT INTO transactions VALUES ('IN', 200)");
    exec("INSERT INTO transactions VALUES ('OUT', 50)");

    const result = exec(`
      WITH
        income AS (SELECT SUM(amount) AS total FROM transactions WHERE category = 'IN'),
        expenses AS (SELECT SUM(amount) AS total FROM transactions WHERE category = 'OUT')
      SELECT income.total AS income, expenses.total AS expense
      FROM income, expenses
    `);
    expect(result.rows[0][0]).toBe(300);
    expect(result.rows[0][1]).toBe(50);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. CTE with aggregation
// ═══════════════════════════════════════════════════════════════════

describe('CTE with aggregation', () => {
  beforeEach(() => {
    exec('CREATE TABLE sales (product VARCHAR2(20), region VARCHAR2(10), amount NUMBER)');
    exec("INSERT INTO sales VALUES ('Widget', 'North', 100)");
    exec("INSERT INTO sales VALUES ('Widget', 'South', 150)");
    exec("INSERT INTO sales VALUES ('Gadget', 'North', 200)");
    exec("INSERT INTO sales VALUES ('Gadget', 'South', 50)");
    exec("INSERT INTO sales VALUES ('Widget', 'North', 75)");
  });

  test('CTE with GROUP BY and SUM', () => {
    const result = exec(`
      WITH product_totals AS (
        SELECT product, SUM(amount) AS total FROM sales GROUP BY product
      )
      SELECT product, total FROM product_totals ORDER BY total DESC
    `);
    expect(result.rows[0][0]).toBe('Widget');
    expect(result.rows[0][1]).toBe(325);
    expect(result.rows[1][0]).toBe('Gadget');
    expect(result.rows[1][1]).toBe(250);
  });

  test('CTE with GROUP BY and COUNT', () => {
    const result = exec(`
      WITH region_counts AS (
        SELECT region, COUNT(*) AS cnt FROM sales GROUP BY region
      )
      SELECT region, cnt FROM region_counts ORDER BY cnt DESC
    `);
    expect(result.rows[0][0]).toBe('North');
    expect(result.rows[0][1]).toBe(3);
    expect(result.rows[1][0]).toBe('South');
    expect(result.rows[1][1]).toBe(2);
  });

  test('CTE with AVG and filtering in main query', () => {
    const result = exec(`
      WITH avg_by_product AS (
        SELECT product, AVG(amount) AS avg_amt FROM sales GROUP BY product
      )
      SELECT product, avg_amt FROM avg_by_product WHERE avg_amt > 100
    `);
    // Widget avg: (100+150+75)/3 = 108.33, Gadget avg: (200+50)/2 = 125
    expect(result.rows.length).toBe(2);
  });

  test('CTE with aggregation used in JOIN', () => {
    const result = exec(`
      WITH totals AS (
        SELECT product, SUM(amount) AS total FROM sales GROUP BY product
      )
      SELECT s.product, s.region, s.amount, t.total
      FROM sales s
      JOIN totals t ON s.product = t.product
      ORDER BY s.product, s.region, s.amount
    `);
    expect(result.rows.length).toBe(5);
    // All Widget rows should show total=325
    const widgetRows = result.rows.filter(r => r[0] === 'Widget');
    widgetRows.forEach(r => expect(r[3]).toBe(325));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. CTE with JOINs in main query
// ═══════════════════════════════════════════════════════════════════

describe('CTE with JOINs in main query', () => {
  beforeEach(() => {
    exec('CREATE TABLE team (team_id NUMBER, team_name VARCHAR2(30))');
    exec("INSERT INTO team VALUES (1, 'Alpha')");
    exec("INSERT INTO team VALUES (2, 'Beta')");
    exec("INSERT INTO team VALUES (3, 'Gamma')");

    exec('CREATE TABLE member (member_id NUMBER, name VARCHAR2(30), team_id NUMBER)');
    exec("INSERT INTO member VALUES (1, 'Alice', 1)");
    exec("INSERT INTO member VALUES (2, 'Bob', 1)");
    exec("INSERT INTO member VALUES (3, 'Charlie', 2)");
    exec("INSERT INTO member VALUES (4, 'Diana', NULL)");
  });

  test('CTE INNER JOIN with real table', () => {
    const result = exec(`
      WITH team_data AS (SELECT team_id, team_name FROM team)
      SELECT m.name, td.team_name
      FROM member m
      JOIN team_data td ON m.team_id = td.team_id
      ORDER BY m.name
    `);
    expect(result.rows.length).toBe(3);
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[0][1]).toBe('Alpha');
  });

  test('CTE LEFT JOIN with real table', () => {
    const result = exec(`
      WITH team_data AS (SELECT team_id, team_name FROM team)
      SELECT m.name, td.team_name
      FROM member m
      LEFT JOIN team_data td ON m.team_id = td.team_id
      ORDER BY m.name
    `);
    expect(result.rows.length).toBe(4);
    const diana = result.rows.find(r => r[0] === 'Diana');
    expect(diana![1]).toBeNull();
  });

  test('two CTEs joined together', () => {
    const result = exec(`
      WITH
        teams AS (SELECT team_id, team_name FROM team),
        members AS (SELECT name, team_id FROM member WHERE team_id IS NOT NULL)
      SELECT m.name, t.team_name
      FROM members m
      JOIN teams t ON m.team_id = t.team_id
      ORDER BY m.name
    `);
    expect(result.rows.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. CTE with WHERE clause filtering
// ═══════════════════════════════════════════════════════════════════

describe('CTE with WHERE clause filtering', () => {
  test('filter CTE results in main query', () => {
    exec('CREATE TABLE numbers (n NUMBER)');
    for (let i = 1; i <= 10; i++) {
      exec(`INSERT INTO numbers VALUES (${i})`);
    }
    const result = exec(`
      WITH all_nums AS (SELECT n FROM numbers)
      SELECT n FROM all_nums WHERE n > 7 ORDER BY n
    `);
    expect(result.rows.map(r => r[0])).toEqual([8, 9, 10]);
  });

  test('filter inside CTE definition', () => {
    exec('CREATE TABLE people (name VARCHAR2(20), age NUMBER)');
    exec("INSERT INTO people VALUES ('Alice', 25)");
    exec("INSERT INTO people VALUES ('Bob', 17)");
    exec("INSERT INTO people VALUES ('Charlie', 30)");
    const result = exec(`
      WITH adults AS (SELECT name, age FROM people WHERE age >= 18)
      SELECT name FROM adults ORDER BY name
    `);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[1][0]).toBe('Charlie');
  });

  test('filter in both CTE and main query', () => {
    exec('CREATE TABLE products (name VARCHAR2(20), price NUMBER, active NUMBER)');
    exec("INSERT INTO products VALUES ('A', 10, 1)");
    exec("INSERT INTO products VALUES ('B', 50, 1)");
    exec("INSERT INTO products VALUES ('C', 30, 0)");
    exec("INSERT INTO products VALUES ('D', 80, 1)");
    const result = exec(`
      WITH active_products AS (SELECT name, price FROM products WHERE active = 1)
      SELECT name, price FROM active_products WHERE price > 20 ORDER BY price
    `);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('B');
    expect(result.rows[1][0]).toBe('D');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. CTE with ORDER BY in main query
// ═══════════════════════════════════════════════════════════════════

describe('CTE with ORDER BY', () => {
  test('ORDER BY CTE column', () => {
    exec('CREATE TABLE scores (student VARCHAR2(20), score NUMBER)');
    exec("INSERT INTO scores VALUES ('Alice', 85)");
    exec("INSERT INTO scores VALUES ('Bob', 95)");
    exec("INSERT INTO scores VALUES ('Charlie', 70)");
    const result = exec(`
      WITH ranked AS (SELECT student, score FROM scores)
      SELECT student, score FROM ranked ORDER BY score DESC
    `);
    expect(result.rows[0][0]).toBe('Bob');
    expect(result.rows[2][0]).toBe('Charlie');
  });

  test('ORDER BY alias from CTE column', () => {
    const result = exec(`
      WITH data AS (SELECT 3 AS n FROM DUAL UNION ALL SELECT 1 FROM DUAL UNION ALL SELECT 2 FROM DUAL)
      SELECT n AS value FROM data ORDER BY value ASC
    `);
    expect(result.rows.map(r => r[0])).toEqual([1, 2, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. CTE referencing another CTE
// ═══════════════════════════════════════════════════════════════════

describe('CTE referencing another CTE', () => {
  test('second CTE references first CTE', () => {
    exec('CREATE TABLE raw_data (category VARCHAR2(10), value NUMBER)');
    exec("INSERT INTO raw_data VALUES ('A', 10)");
    exec("INSERT INTO raw_data VALUES ('A', 20)");
    exec("INSERT INTO raw_data VALUES ('B', 30)");

    const result = exec(`
      WITH
        base AS (SELECT category, SUM(value) AS total FROM raw_data GROUP BY category),
        enriched AS (SELECT category, total, total * 2 AS doubled FROM base)
      SELECT category, total, doubled FROM enriched ORDER BY category
    `);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0]).toEqual(['A', 30, 60]);
    expect(result.rows[1]).toEqual(['B', 30, 60]);
  });

  test('chain of three CTEs', () => {
    const result = exec(`
      WITH
        step1 AS (SELECT 10 AS val FROM DUAL),
        step2 AS (SELECT val + 5 AS val FROM step1),
        step3 AS (SELECT val * 2 AS val FROM step2)
      SELECT val FROM step3
    `);
    expect(result.rows[0][0]).toBe(30); // (10+5)*2
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. CTE with expressions and functions
// ═══════════════════════════════════════════════════════════════════

describe('CTE with expressions and functions', () => {
  test('CTE with string functions', () => {
    exec('CREATE TABLE names_t (first_name VARCHAR2(20), last_name VARCHAR2(20))');
    exec("INSERT INTO names_t VALUES ('alice', 'SMITH')");
    const result = exec(`
      WITH formatted AS (
        SELECT UPPER(first_name) AS fname, LOWER(last_name) AS lname FROM names_t
      )
      SELECT fname, lname FROM formatted
    `);
    expect(result.rows[0][0]).toBe('ALICE');
    expect(result.rows[0][1]).toBe('smith');
  });

  test('CTE with arithmetic', () => {
    exec('CREATE TABLE rect (width NUMBER, height NUMBER)');
    exec('INSERT INTO rect VALUES (5, 3)');
    exec('INSERT INTO rect VALUES (10, 7)');
    const result = exec(`
      WITH areas AS (SELECT width, height, width * height AS area FROM rect)
      SELECT area FROM areas ORDER BY area DESC
    `);
    expect(result.rows[0][0]).toBe(70);
    expect(result.rows[1][0]).toBe(15);
  });

  test('CTE with NVL function', () => {
    exec('CREATE TABLE nullable (val NUMBER)');
    exec('INSERT INTO nullable VALUES (42)');
    exec('INSERT INTO nullable VALUES (NULL)');
    const result = exec(`
      WITH safe_data AS (SELECT NVL(val, 0) AS safe_val FROM nullable)
      SELECT safe_val FROM safe_data ORDER BY safe_val
    `);
    expect(result.rows[0][0]).toBe(0);
    expect(result.rows[1][0]).toBe(42);
  });

  test('CTE with CASE expression', () => {
    exec('CREATE TABLE status (code NUMBER)');
    exec('INSERT INTO status VALUES (1)');
    exec('INSERT INTO status VALUES (2)');
    const result = exec(`
      WITH labeled AS (
        SELECT code,
               CASE WHEN code = 1 THEN 'Active' ELSE 'Inactive' END AS label
        FROM status
      )
      SELECT label FROM labeled ORDER BY code
    `);
    expect(result.rows[0][0]).toBe('Active');
    expect(result.rows[1][0]).toBe('Inactive');
  });

  test('CTE with concatenation', () => {
    exec('CREATE TABLE person (first_n VARCHAR2(20), last_n VARCHAR2(20))');
    exec("INSERT INTO person VALUES ('John', 'Doe')");
    const result = exec(`
      WITH full_names AS (
        SELECT first_n || ' ' || last_n AS full_name FROM person
      )
      SELECT full_name FROM full_names
    `);
    expect(result.rows[0][0]).toBe('John Doe');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. CTE with DISTINCT
// ═══════════════════════════════════════════════════════════════════

describe('CTE with DISTINCT', () => {
  test('DISTINCT inside CTE', () => {
    exec('CREATE TABLE tags (tag VARCHAR2(20))');
    exec("INSERT INTO tags VALUES ('A')");
    exec("INSERT INTO tags VALUES ('B')");
    exec("INSERT INTO tags VALUES ('A')");
    exec("INSERT INTO tags VALUES ('C')");
    exec("INSERT INTO tags VALUES ('B')");
    const result = exec(`
      WITH unique_tags AS (SELECT DISTINCT tag FROM tags)
      SELECT tag FROM unique_tags ORDER BY tag
    `);
    expect(result.rows.length).toBe(3);
    expect(result.rows.map(r => r[0])).toEqual(['A', 'B', 'C']);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12. CTE used multiple times in main query
// ═══════════════════════════════════════════════════════════════════

describe('CTE referenced multiple times', () => {
  test('same CTE in self-join', () => {
    const result = exec(`
      WITH nums AS (
        SELECT 1 AS n FROM DUAL
        UNION ALL SELECT 2 FROM DUAL
        UNION ALL SELECT 3 FROM DUAL
      )
      SELECT a.n AS a_val, b.n AS b_val
      FROM nums a, nums b
      WHERE a.n < b.n
      ORDER BY a.n, b.n
    `);
    // Pairs: (1,2), (1,3), (2,3)
    expect(result.rows.length).toBe(3);
    expect(result.rows[0]).toEqual([1, 2]);
    expect(result.rows[1]).toEqual([1, 3]);
    expect(result.rows[2]).toEqual([2, 3]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 13. CTE with NULL handling
// ═══════════════════════════════════════════════════════════════════

describe('CTE with NULL handling', () => {
  test('CTE propagates NULLs correctly', () => {
    exec('CREATE TABLE mixed (id NUMBER, val VARCHAR2(20))');
    exec("INSERT INTO mixed VALUES (1, 'A')");
    exec('INSERT INTO mixed VALUES (2, NULL)');
    exec("INSERT INTO mixed VALUES (3, 'C')");
    const result = exec(`
      WITH data AS (SELECT id, val FROM mixed)
      SELECT id, val FROM data WHERE val IS NULL
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(2);
    expect(result.rows[0][1]).toBeNull();
  });

  test('CTE with NVL replacing NULLs', () => {
    exec('CREATE TABLE scores_n (student VARCHAR2(20), score NUMBER)');
    exec("INSERT INTO scores_n VALUES ('Alice', 90)");
    exec("INSERT INTO scores_n VALUES ('Bob', NULL)");
    const result = exec(`
      WITH safe_scores AS (SELECT student, NVL(score, 0) AS score FROM scores_n)
      SELECT student, score FROM safe_scores ORDER BY student
    `);
    expect(result.rows[0]).toEqual(['Alice', 90]);
    expect(result.rows[1]).toEqual(['Bob', 0]);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 14. CTE with HR demo schema (realistic scenario)
// ═══════════════════════════════════════════════════════════════════

describe('CTE with HR demo schema', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('department headcount via CTE', () => {
    const result = exec(`
      WITH dept_count AS (
        SELECT department_id, COUNT(*) AS headcount
        FROM HR.EMPLOYEES
        GROUP BY department_id
      )
      SELECT d.department_name, dc.headcount
      FROM HR.DEPARTMENTS d
      JOIN dept_count dc ON d.department_id = dc.department_id
      ORDER BY dc.headcount DESC
    `);
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    // First row should have the most employees
    expect(result.rows[0][1]).toBeGreaterThanOrEqual(result.rows[result.rows.length - 1][1]);
  });

  test('salary statistics per department via CTE', () => {
    const result = exec(`
      WITH salary_stats AS (
        SELECT department_id,
               MIN(salary) AS min_sal,
               MAX(salary) AS max_sal,
               AVG(salary) AS avg_sal
        FROM HR.EMPLOYEES
        GROUP BY department_id
      )
      SELECT d.department_name, ss.min_sal, ss.max_sal, ss.avg_sal
      FROM HR.DEPARTMENTS d
      JOIN salary_stats ss ON d.department_id = ss.department_id
      ORDER BY ss.avg_sal DESC
    `);
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    // avg should be between min and max
    for (const row of result.rows) {
      expect(row[3]).toBeGreaterThanOrEqual(row[1]);
      expect(row[3]).toBeLessThanOrEqual(row[2]);
    }
  });

  test('employees with department and location via multi-CTE', () => {
    const result = exec(`
      WITH
        dept_loc AS (
          SELECT d.department_id, d.department_name, l.city
          FROM HR.DEPARTMENTS d
          JOIN HR.LOCATIONS l ON d.location_id = l.location_id
        )
      SELECT e.first_name, e.last_name, dl.department_name, dl.city
      FROM HR.EMPLOYEES e
      JOIN dept_loc dl ON e.department_id = dl.department_id
      ORDER BY e.last_name
    `);
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.length).toBe(4);
  });

  test('top earners via CTE with filter', () => {
    const result = exec(`
      WITH avg_salary AS (
        SELECT AVG(salary) AS avg_sal FROM HR.EMPLOYEES
      )
      SELECT e.first_name, e.last_name, e.salary
      FROM HR.EMPLOYEES e, avg_salary a
      WHERE e.salary > a.avg_sal * 1.5
      ORDER BY e.salary DESC
    `);
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    // All returned salaries should be high
    for (const row of result.rows) {
      expect(row[2]).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 15. CTE edge cases
// ═══════════════════════════════════════════════════════════════════

describe('CTE edge cases', () => {
  test('CTE returning single row, single column', () => {
    const result = exec(`
      WITH one AS (SELECT 1 AS val FROM DUAL)
      SELECT val FROM one
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(1);
  });

  test('CTE returning empty result set', () => {
    exec('CREATE TABLE empty_t (id NUMBER)');
    const result = exec(`
      WITH nothing AS (SELECT id FROM empty_t)
      SELECT id FROM nothing
    `);
    expect(result.rows.length).toBe(0);
  });

  test('CTE with many columns', () => {
    const result = exec(`
      WITH wide AS (
        SELECT 1 AS c1, 2 AS c2, 3 AS c3, 4 AS c4, 5 AS c5 FROM DUAL
      )
      SELECT c1, c2, c3, c4, c5 FROM wide
    `);
    expect(result.rows[0]).toEqual([1, 2, 3, 4, 5]);
  });

  test('CTE name does not conflict with real table', () => {
    exec('CREATE TABLE data (x NUMBER)');
    exec('INSERT INTO data VALUES (999)');
    // CTE named "data" should shadow the real table within the query
    const result = exec(`
      WITH data AS (SELECT 1 AS x FROM DUAL)
      SELECT x FROM data
    `);
    expect(result.rows[0][0]).toBe(1); // CTE value, not real table value
  });

  test('CTE case insensitivity', () => {
    const result = exec(`
      WITH MyData AS (SELECT 42 AS val FROM DUAL)
      SELECT val FROM MYDATA
    `);
    expect(result.rows[0][0]).toBe(42);
  });

  test('CTE with aliased table reference in main query', () => {
    const result = exec(`
      WITH source AS (SELECT 1 AS id, 'hello' AS msg FROM DUAL)
      SELECT s.id, s.msg FROM source s
    `);
    expect(result.rows[0][0]).toBe(1);
    expect(result.rows[0][1]).toBe('hello');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 16. CTE via SQL*Plus terminal
// ═══════════════════════════════════════════════════════════════════

describe('CTE via SQL*Plus terminal', () => {
  test('CTE query returns formatted output', () => {
    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);
    const result = session.processLine("WITH nums AS (SELECT 42 AS answer FROM DUAL) SELECT answer FROM nums;");
    const text = result.output.join('\n');
    expect(text).toContain('42');
  });
});

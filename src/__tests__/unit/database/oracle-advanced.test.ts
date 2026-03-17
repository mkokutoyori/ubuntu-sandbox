/**
 * Advanced Oracle SQL tests — TDD approach.
 *
 * These tests cover features that are parsed but not yet fully implemented
 * in the executor: JOINs, GROUP BY, aggregates, HAVING, set operations,
 * subqueries, and ALTER TABLE MODIFY.
 *
 * Run: npx vitest run src/__tests__/unit/database/oracle-advanced.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;

function exec(sql: string) {
  const { executor } = db.connectAsSysdba();
  return db.executeSql(executor, sql);
}

// ── Shared fixtures ─────────────────────────────────────────────────

function setupEmployeesAndDepartments() {
  exec(`CREATE TABLE dept (
    dept_id NUMBER NOT NULL,
    dept_name VARCHAR2(30) NOT NULL,
    location VARCHAR2(30)
  )`);
  exec(`CREATE TABLE emp (
    emp_id NUMBER NOT NULL,
    emp_name VARCHAR2(30) NOT NULL,
    dept_id NUMBER,
    salary NUMBER,
    commission NUMBER
  )`);

  // Departments
  exec("INSERT INTO dept VALUES (10, 'Engineering', 'San Francisco')");
  exec("INSERT INTO dept VALUES (20, 'Marketing', 'New York')");
  exec("INSERT INTO dept VALUES (30, 'Sales', 'Chicago')");
  exec("INSERT INTO dept VALUES (40, 'HR', 'Boston')"); // No employees

  // Employees
  exec("INSERT INTO emp VALUES (1, 'Alice', 10, 9000, NULL)");
  exec("INSERT INTO emp VALUES (2, 'Bob', 10, 8000, NULL)");
  exec("INSERT INTO emp VALUES (3, 'Charlie', 20, 7500, 500)");
  exec("INSERT INTO emp VALUES (4, 'Diana', 20, 7000, 300)");
  exec("INSERT INTO emp VALUES (5, 'Eve', 30, 6000, 1000)");
  exec("INSERT INTO emp VALUES (6, 'Frank', NULL, 5000, NULL)"); // No department
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
});

// ═══════════════════════════════════════════════════════════════════
// ██  JOINs
// ═══════════════════════════════════════════════════════════════════

describe('JOINs', () => {
  beforeEach(() => setupEmployeesAndDepartments());

  describe('INNER JOIN', () => {
    it('returns only matching rows', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        JOIN dept d ON e.dept_id = d.dept_id
        ORDER BY e.emp_id
      `);
      expect(result.rows.length).toBe(5); // Frank excluded (NULL dept_id)
      expect(result.rows[0][0]).toBe('Alice');
      expect(result.rows[0][1]).toBe('Engineering');
    });

    it('handles explicit INNER JOIN keyword', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        INNER JOIN dept d ON e.dept_id = d.dept_id
      `);
      expect(result.rows.length).toBe(5);
    });

    it('works with additional WHERE filter', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        JOIN dept d ON e.dept_id = d.dept_id
        WHERE e.salary > 7000
      `);
      expect(result.rows.length).toBe(3); // Alice(9000), Bob(8000), Charlie(7500)
    });
  });

  describe('LEFT JOIN', () => {
    it('includes unmatched rows from left table with NULLs', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        LEFT JOIN dept d ON e.dept_id = d.dept_id
        ORDER BY e.emp_id
      `);
      expect(result.rows.length).toBe(6); // All employees including Frank
      const frank = result.rows.find(r => r[0] === 'Frank');
      expect(frank).toBeDefined();
      expect(frank![1]).toBeNull(); // Frank has no department
    });

    it('LEFT OUTER JOIN is equivalent', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        LEFT OUTER JOIN dept d ON e.dept_id = d.dept_id
      `);
      expect(result.rows.length).toBe(6);
    });
  });

  describe('RIGHT JOIN', () => {
    it('includes unmatched rows from right table with NULLs', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        RIGHT JOIN dept d ON e.dept_id = d.dept_id
        ORDER BY d.dept_id
      `);
      // 5 matched employees + 1 unmatched HR department
      const hrRow = result.rows.find(r => r[1] === 'HR');
      expect(hrRow).toBeDefined();
      expect(hrRow![0]).toBeNull(); // No employee in HR
    });
  });

  describe('FULL OUTER JOIN', () => {
    it('includes unmatched rows from both tables', () => {
      const result = exec(`
        SELECT e.emp_name, d.dept_name
        FROM emp e
        FULL OUTER JOIN dept d ON e.dept_id = d.dept_id
      `);
      // 5 matched + Frank (no dept) + HR (no employees) = 7
      expect(result.rows.length).toBe(7);
      const frank = result.rows.find(r => r[0] === 'Frank');
      expect(frank![1]).toBeNull();
      const hr = result.rows.find(r => r[1] === 'HR');
      expect(hr![0]).toBeNull();
    });
  });

  describe('CROSS JOIN', () => {
    it('produces cartesian product', () => {
      exec('CREATE TABLE colors (name VARCHAR2(10))');
      exec("INSERT INTO colors VALUES ('Red')");
      exec("INSERT INTO colors VALUES ('Blue')");

      exec('CREATE TABLE sizes (name VARCHAR2(10))');
      exec("INSERT INTO sizes VALUES ('S')");
      exec("INSERT INTO sizes VALUES ('M')");
      exec("INSERT INTO sizes VALUES ('L')");

      const result = exec(`
        SELECT c.name, s.name FROM colors c CROSS JOIN sizes s
      `);
      expect(result.rows.length).toBe(6); // 2 * 3
    });
  });

  describe('Multiple JOINs', () => {
    it('handles chained JOINs', () => {
      exec(`CREATE TABLE projects (
        proj_id NUMBER NOT NULL,
        proj_name VARCHAR2(30),
        dept_id NUMBER
      )`);
      exec("INSERT INTO projects VALUES (1, 'Alpha', 10)");
      exec("INSERT INTO projects VALUES (2, 'Beta', 20)");

      const result = exec(`
        SELECT e.emp_name, d.dept_name, p.proj_name
        FROM emp e
        JOIN dept d ON e.dept_id = d.dept_id
        JOIN projects p ON d.dept_id = p.dept_id
        ORDER BY e.emp_id
      `);
      // Alice,Bob → Engineering → Alpha; Charlie,Diana → Marketing → Beta
      expect(result.rows.length).toBe(4);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ██  GROUP BY + Aggregate Functions
// ═══════════════════════════════════════════════════════════════════

describe('GROUP BY and Aggregates', () => {
  beforeEach(() => setupEmployeesAndDepartments());

  describe('COUNT', () => {
    it('COUNT(*) counts all rows', () => {
      const result = exec('SELECT COUNT(*) FROM emp');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe(6);
    });

    it('COUNT(column) excludes NULLs', () => {
      const result = exec('SELECT COUNT(commission) FROM emp');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe(3); // Charlie, Diana, Eve have commission
    });

    it('COUNT(DISTINCT column) counts unique values', () => {
      const result = exec('SELECT COUNT(DISTINCT dept_id) FROM emp');
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe(3); // 10, 20, 30 (NULL excluded)
    });
  });

  describe('SUM', () => {
    it('sums all values', () => {
      const result = exec('SELECT SUM(salary) FROM emp');
      expect(result.rows[0][0]).toBe(42500);
    });

    it('SUM ignores NULLs', () => {
      const result = exec('SELECT SUM(commission) FROM emp');
      expect(result.rows[0][0]).toBe(1800); // 500 + 300 + 1000
    });
  });

  describe('AVG', () => {
    it('computes average', () => {
      const result = exec('SELECT AVG(salary) FROM emp');
      const avg = result.rows[0][0] as number;
      expect(avg).toBeCloseTo(42500 / 6, 2);
    });

    it('AVG ignores NULLs', () => {
      const result = exec('SELECT AVG(commission) FROM emp');
      const avg = result.rows[0][0] as number;
      expect(avg).toBeCloseTo(1800 / 3, 2); // Only 3 non-null commissions
    });
  });

  describe('MIN / MAX', () => {
    it('finds min and max', () => {
      const minResult = exec('SELECT MIN(salary) FROM emp');
      expect(minResult.rows[0][0]).toBe(5000);

      const maxResult = exec('SELECT MAX(salary) FROM emp');
      expect(maxResult.rows[0][0]).toBe(9000);
    });

    it('works with strings', () => {
      const result = exec('SELECT MIN(emp_name), MAX(emp_name) FROM emp');
      expect(result.rows[0][0]).toBe('Alice');
      expect(result.rows[0][1]).toBe('Frank');
    });
  });

  describe('GROUP BY', () => {
    it('groups rows by a column', () => {
      const result = exec(`
        SELECT dept_id, COUNT(*) FROM emp
        GROUP BY dept_id
        ORDER BY dept_id
      `);
      // dept_id: 10→2, 20→2, 30→1, NULL→1
      expect(result.rows.length).toBe(4);
      expect(result.rows[0][0]).toBe(10);
      expect(result.rows[0][1]).toBe(2); // Alice, Bob
      expect(result.rows[1][0]).toBe(20);
      expect(result.rows[1][1]).toBe(2); // Charlie, Diana
    });

    it('GROUP BY with SUM', () => {
      const result = exec(`
        SELECT dept_id, SUM(salary) FROM emp
        GROUP BY dept_id
        ORDER BY dept_id
      `);
      expect(result.rows[0][1]).toBe(17000); // Engineering: 9000+8000
      expect(result.rows[1][1]).toBe(14500); // Marketing: 7500+7000
    });

    it('GROUP BY with multiple aggregates', () => {
      const result = exec(`
        SELECT dept_id, COUNT(*), SUM(salary), AVG(salary), MIN(salary), MAX(salary)
        FROM emp
        GROUP BY dept_id
        ORDER BY dept_id
      `);
      // Engineering: count=2, sum=17000, avg=8500, min=8000, max=9000
      expect(result.rows[0][1]).toBe(2);
      expect(result.rows[0][2]).toBe(17000);
      expect(result.rows[0][3]).toBeCloseTo(8500, 0);
      expect(result.rows[0][4]).toBe(8000);
      expect(result.rows[0][5]).toBe(9000);
    });

    it('GROUP BY with expression in SELECT', () => {
      const result = exec(`
        SELECT dept_id, COUNT(*), SUM(salary) / COUNT(*) AS avg_sal
        FROM emp
        WHERE dept_id IS NOT NULL
        GROUP BY dept_id
        ORDER BY dept_id
      `);
      expect(result.rows.length).toBe(3); // NULL dept_id filtered out
    });
  });

  describe('HAVING', () => {
    it('filters groups by aggregate condition', () => {
      const result = exec(`
        SELECT dept_id, COUNT(*)
        FROM emp
        GROUP BY dept_id
        HAVING COUNT(*) >= 2
        ORDER BY dept_id
      `);
      // Only dept 10 and 20 have 2+ employees
      expect(result.rows.length).toBe(2);
      expect(result.rows[0][0]).toBe(10);
      expect(result.rows[1][0]).toBe(20);
    });

    it('HAVING with SUM', () => {
      const result = exec(`
        SELECT dept_id, SUM(salary)
        FROM emp
        GROUP BY dept_id
        HAVING SUM(salary) > 15000
      `);
      expect(result.rows.length).toBe(1); // Only Engineering: 17000
      expect(result.rows[0][0]).toBe(10);
    });

    it('WHERE + GROUP BY + HAVING combined', () => {
      const result = exec(`
        SELECT dept_id, AVG(salary)
        FROM emp
        WHERE salary > 5000
        GROUP BY dept_id
        HAVING AVG(salary) > 7000
        ORDER BY dept_id
      `);
      // After WHERE (salary > 5000): excludes Frank
      // Group 10: avg=8500, Group 20: avg=7250, Group 30: avg=6000
      // After HAVING (> 7000): 10 and 20
      expect(result.rows.length).toBe(2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ██  Set Operations (UNION, INTERSECT, MINUS)
// ═══════════════════════════════════════════════════════════════════

describe('Set Operations', () => {
  beforeEach(() => {
    setupEmployeesAndDepartments();
  });

  describe('UNION', () => {
    it('combines results and removes duplicates', () => {
      const result = exec(`
        SELECT dept_id FROM emp WHERE dept_id = 10
        UNION
        SELECT dept_id FROM emp WHERE dept_id = 10
      `);
      expect(result.rows.length).toBe(1); // deduplicated
      expect(result.rows[0][0]).toBe(10);
    });

    it('UNION ALL keeps duplicates', () => {
      const result = exec(`
        SELECT dept_id FROM emp WHERE dept_id = 10
        UNION ALL
        SELECT dept_id FROM emp WHERE dept_id = 10
      `);
      expect(result.rows.length).toBe(4); // 2 + 2
    });

    it('UNION of different data sets', () => {
      const result = exec(`
        SELECT emp_name FROM emp WHERE dept_id = 10
        UNION
        SELECT emp_name FROM emp WHERE dept_id = 20
      `);
      expect(result.rows.length).toBe(4); // Alice, Bob, Charlie, Diana
    });
  });

  describe('INTERSECT', () => {
    it('returns only rows present in both queries', () => {
      const result = exec(`
        SELECT dept_id FROM emp WHERE salary > 7000
        INTERSECT
        SELECT dept_id FROM emp WHERE salary < 8000
      `);
      // salary > 7000: dept 10(9000,8000), 20(7500)
      // salary < 8000: dept 20(7500,7000), 30(6000), NULL(5000)
      // Intersection of dept_ids: 20
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe(20);
    });
  });

  describe('MINUS', () => {
    it('returns rows in first query but not in second', () => {
      const result = exec(`
        SELECT dept_id FROM dept
        MINUS
        SELECT dept_id FROM emp WHERE dept_id IS NOT NULL
      `);
      // dept has 10,20,30,40. emp has 10,20,30
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe(40);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ██  Subqueries
// ═══════════════════════════════════════════════════════════════════

describe('Subqueries', () => {
  beforeEach(() => setupEmployeesAndDepartments());

  describe('IN subquery', () => {
    it('filters using subquery result set', () => {
      const result = exec(`
        SELECT emp_name FROM emp
        WHERE dept_id IN (SELECT dept_id FROM dept WHERE dept_name = 'Engineering')
        ORDER BY emp_name
      `);
      expect(result.rows.length).toBe(2);
      expect(result.rows[0][0]).toBe('Alice');
      expect(result.rows[1][0]).toBe('Bob');
    });

    it('NOT IN subquery', () => {
      const result = exec(`
        SELECT emp_name FROM emp
        WHERE dept_id NOT IN (SELECT dept_id FROM dept WHERE dept_name = 'Engineering')
        AND dept_id IS NOT NULL
        ORDER BY emp_name
      `);
      expect(result.rows.length).toBe(3); // Charlie, Diana, Eve
    });
  });

  describe('EXISTS subquery', () => {
    it('returns rows where correlated subquery finds matches', () => {
      const result = exec(`
        SELECT d.dept_name FROM dept d
        WHERE EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.dept_id)
        ORDER BY d.dept_name
      `);
      // Departments with employees: Engineering, Marketing, Sales
      expect(result.rows.length).toBe(3);
    });

    it('NOT EXISTS', () => {
      const result = exec(`
        SELECT d.dept_name FROM dept d
        WHERE NOT EXISTS (SELECT 1 FROM emp e WHERE e.dept_id = d.dept_id)
      `);
      // Department without employees: HR
      expect(result.rows.length).toBe(1);
      expect(result.rows[0][0]).toBe('HR');
    });
  });

  describe('Scalar subquery', () => {
    it('in SELECT list', () => {
      const result = exec(`
        SELECT emp_name,
               (SELECT dept_name FROM dept WHERE dept_id = e.dept_id) AS dept
        FROM emp e
        WHERE emp_id = 1
      `);
      expect(result.rows[0][0]).toBe('Alice');
      expect(result.rows[0][1]).toBe('Engineering');
    });

    it('in WHERE comparison', () => {
      const result = exec(`
        SELECT emp_name FROM emp
        WHERE salary > (SELECT AVG(salary) FROM emp)
        ORDER BY salary DESC
      `);
      // AVG = 42500/6 = ~7083. > 7083: Alice(9000), Bob(8000), Charlie(7500)
      expect(result.rows.length).toBe(3);
      expect(result.rows[0][0]).toBe('Alice');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// ██  ALTER TABLE MODIFY
// ═══════════════════════════════════════════════════════════════════

describe('ALTER TABLE MODIFY', () => {
  beforeEach(() => {
    exec('CREATE TABLE test_mod (id NUMBER, name VARCHAR2(20), status VARCHAR2(5))');
    exec("INSERT INTO test_mod VALUES (1, 'Alice', 'A')");
  });

  it('modifies column data type', () => {
    exec('ALTER TABLE test_mod MODIFY name VARCHAR2(50)');
    const meta = db.storage.getTableMeta('SYS', 'TEST_MOD');
    const nameCol = meta!.columns.find(c => c.name === 'NAME');
    expect(nameCol!.dataType.precision).toBe(50);
  });

  it('modifies column to NOT NULL', () => {
    exec('ALTER TABLE test_mod MODIFY name VARCHAR2(20) NOT NULL');
    const meta = db.storage.getTableMeta('SYS', 'TEST_MOD');
    const nameCol = meta!.columns.find(c => c.name === 'NAME');
    expect(nameCol!.dataType.nullable).toBe(false);
  });

  it('preserves existing data after MODIFY', () => {
    exec('ALTER TABLE test_mod MODIFY name VARCHAR2(50)');
    const result = exec('SELECT name FROM test_mod WHERE id = 1');
    expect(result.rows[0][0]).toBe('Alice');
  });
});

// ═══════════════════════════════════════════════════════════════════
// ██  Advanced Expression Tests
// ═══════════════════════════════════════════════════════════════════

describe('Advanced Expressions', () => {
  it('nested CASE in WHERE', () => {
    exec('CREATE TABLE data (id NUMBER, val NUMBER)');
    exec('INSERT INTO data VALUES (1, 10)');
    exec('INSERT INTO data VALUES (2, 20)');
    exec('INSERT INTO data VALUES (3, 30)');

    const result = exec(`
      SELECT id, CASE WHEN val < 15 THEN 'LOW' WHEN val < 25 THEN 'MED' ELSE 'HIGH' END AS cat
      FROM data
      ORDER BY id
    `);
    expect(result.rows[0][1]).toBe('LOW');
    expect(result.rows[1][1]).toBe('MED');
    expect(result.rows[2][1]).toBe('HIGH');
  });

  it('string concatenation with ||', () => {
    const result = exec("SELECT 'Hello' || ' ' || 'World' FROM DUAL");
    expect(result.rows[0][0]).toBe('Hello World');
  });

  it('arithmetic in SELECT with aliases', () => {
    exec('CREATE TABLE items (price NUMBER, qty NUMBER)');
    exec('INSERT INTO items VALUES (10, 5)');
    exec('INSERT INTO items VALUES (20, 3)');

    const result = exec(`
      SELECT price * qty AS total FROM items ORDER BY total DESC
    `);
    expect(result.rows[0][0]).toBe(60);
    expect(result.rows[1][0]).toBe(50);
  });

  it('DECODE function', () => {
    const result = exec("SELECT DECODE(1, 1, 'ONE', 2, 'TWO', 'OTHER') FROM DUAL");
    expect(result.rows[0][0]).toBe('ONE');
  });

  it('nested NVL', () => {
    const result = exec("SELECT NVL(NVL(NULL, NULL), 'fallback') FROM DUAL");
    expect(result.rows[0][0]).toBe('fallback');
  });
});

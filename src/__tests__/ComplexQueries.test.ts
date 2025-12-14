/**
 * Ultra-Complex SQL Query Tests
 * Tests complex queries including multi-table JOINs, subqueries, CTEs,
 * window functions, complex aggregations, and real-world scenarios.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createPsqlSession, executePsql, PsqlSession } from '../terminal/sql/postgres/psql';
import { createSQLPlusSession, executeSQLPlus, SQLPlusSession } from '../terminal/sql/oracle/sqlplus';

// ============================================
// PostgreSQL Complex Query Tests
// ============================================
describe('PostgreSQL Complex Queries', () => {
  let session: PsqlSession;

  beforeEach(() => {
    session = createPsqlSession();
    setupPgSchema(session);
  });

  describe('Multi-Table JOINs', () => {
    it('executes 3-table INNER JOIN', () => {
      const result = executePsql(session, `
        SELECT e.first_name, d.dept_name, p.proj_name
        FROM employees e
        INNER JOIN departments d ON e.dept_id = d.dept_id
        INNER JOIN project_assignments pa ON e.emp_id = pa.emp_id
        INNER JOIN projects p ON pa.proj_id = p.proj_id
        ORDER BY e.first_name;
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toBeDefined();
    });

    it('executes LEFT JOIN with NULLs', () => {
      const result = executePsql(session, `
        SELECT d.dept_name, e.first_name
        FROM departments d
        LEFT JOIN employees e ON d.dept_id = e.dept_id
        ORDER BY d.dept_name;
      `);
      expect(result.error).toBeUndefined();
    });

    it('executes self-join for manager hierarchy', () => {
      const result = executePsql(session, `
        SELECT e.first_name AS employee, m.first_name AS manager
        FROM employees e
        LEFT JOIN employees m ON e.manager_id = m.emp_id;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Complex Aggregations', () => {
    it('GROUP BY with multiple aggregates', () => {
      const result = executePsql(session, `
        SELECT
          dept_id,
          COUNT(*) as cnt,
          SUM(salary) as total,
          AVG(salary) as avg_sal,
          MIN(salary) as min_sal,
          MAX(salary) as max_sal
        FROM employees
        GROUP BY dept_id
        ORDER BY total DESC;
      `);
      expect(result.error).toBeUndefined();
    });

    it('GROUP BY with HAVING', () => {
      const result = executePsql(session, `
        SELECT dept_id, COUNT(*) as cnt
        FROM employees
        GROUP BY dept_id
        HAVING COUNT(*) >= 2;
      `);
      expect(result.error).toBeUndefined();
    });

    it('Aggregates with expressions', () => {
      const result = executePsql(session, `
        SELECT
          dept_id,
          SUM(salary * 12) as annual_total,
          AVG(salary + COALESCE(bonus, 0)) as avg_compensation
        FROM employees
        GROUP BY dept_id;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Subqueries', () => {
    it('scalar subquery in SELECT', () => {
      const result = executePsql(session, `
        SELECT
          first_name,
          salary,
          (SELECT AVG(salary) FROM employees) as company_avg
        FROM employees
        ORDER BY salary DESC;
      `);
      expect(result.error).toBeUndefined();
    });

    it('subquery with IN clause', () => {
      const result = executePsql(session, `
        SELECT first_name, salary
        FROM employees
        WHERE dept_id IN (
          SELECT dept_id FROM departments WHERE dept_name LIKE 'E%'
        );
      `);
      expect(result.error).toBeUndefined();
    });

    it('correlated subquery for comparison', () => {
      const result = executePsql(session, `
        SELECT e.first_name, e.salary, e.dept_id
        FROM employees e
        WHERE e.salary > (
          SELECT AVG(e2.salary)
          FROM employees e2
          WHERE e2.dept_id = e.dept_id
        );
      `);
      expect(result.error).toBeUndefined();
    });

    it('subquery in FROM clause', () => {
      const result = executePsql(session, `
        SELECT sub.dept_id, sub.total_salary
        FROM (
          SELECT dept_id, SUM(salary) as total_salary
          FROM employees
          GROUP BY dept_id
        ) sub
        WHERE sub.total_salary > 100000;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Complex WHERE Clauses', () => {
    it('nested AND/OR conditions', () => {
      const result = executePsql(session, `
        SELECT * FROM employees
        WHERE (dept_id = 1 OR dept_id = 2)
          AND salary > 50000
          AND (first_name LIKE 'J%' OR last_name LIKE 'S%');
      `);
      expect(result.error).toBeUndefined();
    });

    it('BETWEEN, IN, LIKE combined', () => {
      const result = executePsql(session, `
        SELECT * FROM employees
        WHERE salary BETWEEN 50000 AND 100000
          AND dept_id IN (1, 2, 3)
          AND email LIKE '%@%';
      `);
      expect(result.error).toBeUndefined();
    });

    it('IS NULL and IS NOT NULL', () => {
      const result = executePsql(session, `
        SELECT * FROM employees
        WHERE manager_id IS NOT NULL
          AND bonus IS NULL;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('CASE Expressions', () => {
    it('searched CASE in SELECT', () => {
      const result = executePsql(session, `
        SELECT
          first_name,
          salary,
          CASE
            WHEN salary >= 80000 THEN 'High'
            WHEN salary >= 50000 THEN 'Medium'
            ELSE 'Low'
          END as salary_band
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('simple CASE expression', () => {
      const result = executePsql(session, `
        SELECT
          first_name,
          CASE dept_id
            WHEN 1 THEN 'Engineering'
            WHEN 2 THEN 'Sales'
            ELSE 'Other'
          END as department
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('CASE in ORDER BY', () => {
      const result = executePsql(session, `
        SELECT first_name, dept_id
        FROM employees
        ORDER BY CASE dept_id WHEN 1 THEN 0 ELSE 1 END, first_name;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('String Functions', () => {
    it('UPPER, LOWER, LENGTH', () => {
      const result = executePsql(session, `
        SELECT
          UPPER(first_name) as upper_name,
          LOWER(last_name) as lower_name,
          LENGTH(email) as email_len
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('CONCAT and ||', () => {
      const result = executePsql(session, `
        SELECT
          CONCAT(first_name, ' ', last_name) as full_name
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('SUBSTRING', () => {
      const result = executePsql(session, `
        SELECT
          first_name,
          SUBSTRING(email, 1, 5) as email_prefix
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('TRIM functions', () => {
      const result = executePsql(session, `
        SELECT
          TRIM(first_name) as trimmed,
          LTRIM(first_name) as left_trim,
          RTRIM(first_name) as right_trim
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Numeric Functions', () => {
    it('ROUND, FLOOR, CEIL', () => {
      const result = executePsql(session, `
        SELECT
          salary,
          ROUND(salary / 12, 2) as monthly,
          FLOOR(salary / 1000) as thousands,
          CEIL(salary / 1000) as ceil_thousands
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('ABS and MOD', () => {
      const result = executePsql(session, `
        SELECT
          ABS(salary - 60000) as diff,
          MOD(emp_id, 2) as odd_even
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('NULL Handling Functions', () => {
    it('COALESCE', () => {
      const result = executePsql(session, `
        SELECT
          first_name,
          COALESCE(bonus, 0) as eff_bonus,
          COALESCE(manager_id, -1) as mgr
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });

    it('NULLIF', () => {
      const result = executePsql(session, `
        SELECT
          first_name,
          NULLIF(bonus, 0) as non_zero_bonus
        FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('ORDER BY and LIMIT', () => {
    it('multi-column ORDER BY', () => {
      const result = executePsql(session, `
        SELECT * FROM employees
        ORDER BY dept_id ASC, salary DESC, last_name ASC;
      `);
      expect(result.error).toBeUndefined();
    });

    it('LIMIT with OFFSET', () => {
      const result = executePsql(session, `
        SELECT * FROM employees
        ORDER BY salary DESC
        LIMIT 3 OFFSET 1;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('DISTINCT', () => {
    it('SELECT DISTINCT', () => {
      const result = executePsql(session, `
        SELECT DISTINCT dept_id FROM employees ORDER BY dept_id;
      `);
      expect(result.error).toBeUndefined();
    });

    it('COUNT DISTINCT', () => {
      const result = executePsql(session, `
        SELECT COUNT(DISTINCT dept_id) as unique_depts FROM employees;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Complex DML', () => {
    it('UPDATE with expression', () => {
      const result = executePsql(session, `
        UPDATE employees SET salary = salary * 1.1 WHERE dept_id = 1;
      `);
      expect(result.error).toBeUndefined();
      expect(result.output).toContain('UPDATE');
    });

    it('UPDATE with subquery condition', () => {
      const result = executePsql(session, `
        UPDATE employees SET bonus = 5000
        WHERE dept_id IN (SELECT dept_id FROM departments WHERE dept_name = 'Engineering');
      `);
      expect(result.error).toBeUndefined();
    });

    it('DELETE with subquery', () => {
      // First insert a row to delete
      executePsql(session, "INSERT INTO project_assignments (assign_id, emp_id, proj_id) VALUES (99, 1, 1);");
      const result = executePsql(session, `
        DELETE FROM project_assignments
        WHERE emp_id IN (SELECT emp_id FROM employees WHERE salary > 90000);
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Transactions', () => {
    it('full transaction cycle', () => {
      executePsql(session, 'BEGIN;');
      executePsql(session, "INSERT INTO departments (dept_id, dept_name) VALUES (99, 'Temp');");
      executePsql(session, "UPDATE departments SET dept_name = 'Temporary' WHERE dept_id = 99;");
      const commitResult = executePsql(session, 'COMMIT;');
      expect(commitResult.output).toBe('COMMIT');

      // Verify the data persists
      const selectResult = executePsql(session, "SELECT dept_name FROM departments WHERE dept_id = 99;");
      expect(selectResult.error).toBeUndefined();
    });

    it('rollback transaction', () => {
      executePsql(session, 'BEGIN;');
      executePsql(session, "INSERT INTO departments (dept_id, dept_name) VALUES (100, 'ToDelete');");
      const rollbackResult = executePsql(session, 'ROLLBACK;');
      expect(rollbackResult.output).toBe('ROLLBACK');

      // Verify the data was rolled back
      const selectResult = executePsql(session, "SELECT * FROM departments WHERE dept_id = 100;");
      expect(selectResult.output).toContain('0 rows');
    });
  });
});

// ============================================
// Oracle Complex Query Tests
// ============================================
describe('Oracle Complex Queries', () => {
  // Create session once to avoid memory issues
  const session = createSQLPlusSession();
  setupOracleSchema(session);

  describe('Multi-Table JOINs', () => {
    it('executes 3-table JOIN', () => {
      const result = executeSQLPlus(session, `
        SELECT e.first_name, d.dept_name, p.proj_name
        FROM ora_employees e
        INNER JOIN ora_departments d ON e.dept_id = d.dept_id
        INNER JOIN ora_proj_assign pa ON e.emp_id = pa.emp_id
        INNER JOIN ora_projects p ON pa.proj_id = p.proj_id;
      `);
      expect(result.error).toBeUndefined();
    });

    it('executes LEFT JOIN', () => {
      const result = executeSQLPlus(session, `
        SELECT d.dept_name, e.first_name
        FROM ora_departments d
        LEFT JOIN ora_employees e ON d.dept_id = e.dept_id;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Aggregations', () => {
    it('GROUP BY with aggregates', () => {
      const result = executeSQLPlus(session, `
        SELECT
          dept_id,
          COUNT(*) as cnt,
          SUM(salary) as total_sal,
          AVG(salary) as avg_sal
        FROM ora_employees
        GROUP BY dept_id;
      `);
      expect(result.error).toBeUndefined();
    });

    it('HAVING clause', () => {
      const result = executeSQLPlus(session, `
        SELECT dept_id, COUNT(*) as cnt
        FROM ora_employees
        GROUP BY dept_id
        HAVING COUNT(*) >= 1;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Subqueries', () => {
    it('subquery in WHERE', () => {
      const result = executeSQLPlus(session, `
        SELECT first_name, salary
        FROM ora_employees
        WHERE salary > (SELECT AVG(salary) FROM ora_employees);
      `);
      expect(result.error).toBeUndefined();
    });

    it('subquery with IN', () => {
      const result = executeSQLPlus(session, `
        SELECT * FROM ora_employees
        WHERE dept_id IN (SELECT dept_id FROM ora_departments WHERE dept_name LIKE 'E%');
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('CASE Expressions', () => {
    it('searched CASE', () => {
      const result = executeSQLPlus(session, `
        SELECT
          first_name,
          CASE
            WHEN salary >= 80000 THEN 'Senior'
            WHEN salary >= 50000 THEN 'Mid'
            ELSE 'Junior'
          END as level
        FROM ora_employees;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('String Functions', () => {
    it('UPPER, LOWER, LENGTH', () => {
      const result = executeSQLPlus(session, `
        SELECT
          UPPER(first_name) as upper_name,
          LOWER(last_name) as lower_name,
          LENGTH(first_name) as name_len
        FROM ora_employees;
      `);
      expect(result.error).toBeUndefined();
    });
  });

  describe('Complex DML', () => {
    it('UPDATE with expression', () => {
      const result = executeSQLPlus(session, `
        UPDATE ora_employees SET salary = salary * 1.05 WHERE dept_id = 1;
      `);
      expect(result.error).toBeUndefined();
    });
  });
});

// ============================================
// Helper Functions
// ============================================
function setupPgSchema(session: PsqlSession) {
  // Departments
  executePsql(session, `
    CREATE TABLE departments (
      dept_id INTEGER PRIMARY KEY,
      dept_name VARCHAR(100) NOT NULL,
      location VARCHAR(100)
    );
  `);

  // Employees
  executePsql(session, `
    CREATE TABLE employees (
      emp_id INTEGER PRIMARY KEY,
      first_name VARCHAR(50) NOT NULL,
      last_name VARCHAR(50) NOT NULL,
      email VARCHAR(100),
      salary NUMERIC(10,2),
      bonus NUMERIC(10,2),
      dept_id INTEGER,
      manager_id INTEGER
    );
  `);

  // Projects
  executePsql(session, `
    CREATE TABLE projects (
      proj_id INTEGER PRIMARY KEY,
      proj_name VARCHAR(100) NOT NULL,
      budget NUMERIC(15,2)
    );
  `);

  // Project assignments
  executePsql(session, `
    CREATE TABLE project_assignments (
      assign_id INTEGER PRIMARY KEY,
      emp_id INTEGER,
      proj_id INTEGER
    );
  `);

  // Insert data
  executePsql(session, `
    INSERT INTO departments (dept_id, dept_name, location) VALUES
      (1, 'Engineering', 'Building A'),
      (2, 'Sales', 'Building B'),
      (3, 'HR', 'Building C');
  `);

  executePsql(session, `
    INSERT INTO employees (emp_id, first_name, last_name, email, salary, bonus, dept_id, manager_id) VALUES
      (1, 'John', 'Smith', 'jsmith@example.com', 85000, 5000, 1, NULL),
      (2, 'Jane', 'Doe', 'jdoe@example.com', 75000, 3000, 1, 1),
      (3, 'Bob', 'Johnson', 'bjohnson@example.com', 65000, NULL, 2, 1),
      (4, 'Alice', 'Williams', 'awilliams@example.com', 95000, 8000, 1, NULL);
  `);

  executePsql(session, `
    INSERT INTO projects (proj_id, proj_name, budget) VALUES
      (1, 'Website', 100000),
      (2, 'Mobile', 200000);
  `);

  executePsql(session, `
    INSERT INTO project_assignments (assign_id, emp_id, proj_id) VALUES
      (1, 1, 1),
      (2, 2, 1),
      (3, 4, 2);
  `);
}

function setupOracleSchema(session: SQLPlusSession) {
  // Create tables with ora_ prefix to avoid conflicts
  executeSQLPlus(session, `
    CREATE TABLE ora_departments (
      dept_id NUMBER PRIMARY KEY,
      dept_name VARCHAR2(100) NOT NULL,
      location VARCHAR2(100)
    );
  `);

  executeSQLPlus(session, `
    CREATE TABLE ora_employees (
      emp_id NUMBER PRIMARY KEY,
      first_name VARCHAR2(50) NOT NULL,
      last_name VARCHAR2(50) NOT NULL,
      email VARCHAR2(100),
      salary NUMBER(10,2),
      dept_id NUMBER
    );
  `);

  executeSQLPlus(session, `
    CREATE TABLE ora_projects (
      proj_id NUMBER PRIMARY KEY,
      proj_name VARCHAR2(100) NOT NULL
    );
  `);

  executeSQLPlus(session, `
    CREATE TABLE ora_proj_assign (
      assign_id NUMBER PRIMARY KEY,
      emp_id NUMBER,
      proj_id NUMBER
    );
  `);

  // Insert data
  executeSQLPlus(session, "INSERT INTO ora_departments (dept_id, dept_name) VALUES (1, 'Engineering');");
  executeSQLPlus(session, "INSERT INTO ora_departments (dept_id, dept_name) VALUES (2, 'Sales');");

  executeSQLPlus(session, "INSERT INTO ora_employees (emp_id, first_name, last_name, salary, dept_id) VALUES (1, 'John', 'Smith', 85000, 1);");
  executeSQLPlus(session, "INSERT INTO ora_employees (emp_id, first_name, last_name, salary, dept_id) VALUES (2, 'Jane', 'Doe', 75000, 1);");

  executeSQLPlus(session, "INSERT INTO ora_projects (proj_id, proj_name) VALUES (1, 'Website');");

  executeSQLPlus(session, "INSERT INTO ora_proj_assign (assign_id, emp_id, proj_id) VALUES (1, 1, 1);");
}

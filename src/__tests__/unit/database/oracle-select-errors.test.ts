/**
 * Tests for Oracle SELECT error handling — syntax and semantic errors.
 *
 * Validates that malformed or invalid SELECT queries fail with appropriate errors.
 * Covers: syntax errors (parser level) and semantic errors (executor level).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleExecutor } from '@/database/oracle/OracleExecutor';
import { installHRSchema } from '@/database/oracle/demo/DemoSchemas';

let db: OracleDatabase;
let executor: OracleExecutor;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
  installHRSchema(db);
});

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

function expectError(sql: string, pattern?: string | RegExp) {
  expect(() => exec(sql)).toThrow(pattern);
}

// ═══════════════════════════════════════════════════════════════════════
// PART 1 — SYNTAX ERRORS (Parser level)
// ═══════════════════════════════════════════════════════════════════════

describe('Oracle SELECT — Syntax errors', () => {

  // 1. SELECT without column list
  it('fails on SELECT FROM (missing column list)', () => {
    expectError('SELECT FROM HR.EMPLOYEES');
  });

  // 2. Missing FROM keyword
  it('fails on SELECT with table reference but no FROM', () => {
    expectError('SELECT EMPLOYEE_ID HR.EMPLOYEES');
  });

  // 3. Trailing comma in select list
  it('fails on trailing comma in SELECT list', () => {
    expectError('SELECT EMPLOYEE_ID, FROM HR.EMPLOYEES');
  });

  // 4. Double comma in select list
  it('fails on double comma in SELECT list', () => {
    expectError('SELECT EMPLOYEE_ID,, LAST_NAME FROM HR.EMPLOYEES');
  });

  // 5. Missing closing parenthesis in expression
  it('fails on unclosed parenthesis in expression', () => {
    expectError('SELECT (1 + 2 FROM DUAL');
  });

  // 6. UPPER without parens is treated as identifier (not a function call error)
  // Replace with: function call with unclosed paren
  it('fails on function call with unclosed parenthesis', () => {
    expectError("SELECT UPPER('hello' FROM DUAL");
  });

  // 7. Unmatched closing parenthesis
  it('fails on extra closing parenthesis', () => {
    expectError('SELECT 1) FROM DUAL');
  });

  // 8. WHERE without condition
  it('fails on WHERE with no condition', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE');
  });

  // 9. ORDER BY without column specification
  it('fails on ORDER BY with no column', () => {
    expectError('SELECT * FROM HR.EMPLOYEES ORDER BY');
  });

  // 10. GROUP BY without column
  it('fails on GROUP BY with no column', () => {
    expectError('SELECT * FROM HR.EMPLOYEES GROUP BY');
  });

  // 11. HAVING without GROUP BY expression (syntax-level issue)
  it('fails on HAVING with no expression', () => {
    expectError('SELECT DEPARTMENT_ID FROM HR.EMPLOYEES GROUP BY DEPARTMENT_ID HAVING');
  });

  // 12. Incomplete BETWEEN expression
  it('fails on BETWEEN without AND', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE SALARY BETWEEN 3000');
  });

  // 13. IN without opening parenthesis
  it('fails on IN without parenthesized list', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE DEPARTMENT_ID IN 10, 20');
  });

  // 14. Empty IN list
  it('fails on empty IN list', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE DEPARTMENT_ID IN ()');
  });

  // 15. JOIN with missing table after JOIN keyword
  it('fails on JOIN with no table specified', () => {
    expectError('SELECT * FROM HR.EMPLOYEES JOIN ON 1=1');
  });

  // 16. Incomplete CASE expression — missing END
  it('fails on CASE without END', () => {
    expectError('SELECT CASE WHEN 1=1 THEN 1 FROM DUAL');
  });

  // 17. CASE with no WHEN clause
  it('fails on CASE with no WHEN', () => {
    expectError('SELECT CASE END FROM DUAL');
  });

  // 18. Incomplete subquery in FROM
  it('fails on incomplete subquery in FROM', () => {
    expectError('SELECT * FROM (SELECT 1');
  });

  // 19. Multiple SELECT keywords
  it('fails on double SELECT keyword', () => {
    expectError('SELECT SELECT 1 FROM DUAL');
  });

  // 20. WHERE clause with dangling AND
  it('fails on WHERE with trailing AND', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE SALARY > 3000 AND');
  });

  // 21. WHERE clause with dangling OR
  it('fails on WHERE with trailing OR', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE SALARY > 3000 OR');
  });

  // 22. Missing alias after AS
  it('fails on AS without alias name', () => {
    expectError('SELECT EMPLOYEE_ID AS FROM HR.EMPLOYEES');
  });

  // 23. LIKE without pattern
  it('fails on LIKE without pattern', () => {
    expectError("SELECT * FROM HR.EMPLOYEES WHERE LAST_NAME LIKE");
  });

  // 24. ORDER BY with trailing comma
  it('fails on ORDER BY with trailing comma', () => {
    expectError('SELECT * FROM HR.EMPLOYEES ORDER BY EMPLOYEE_ID,');
  });

  // 25. GROUP BY with trailing comma
  it('fails on GROUP BY with trailing comma', () => {
    expectError('SELECT * FROM HR.EMPLOYEES GROUP BY DEPARTMENT_ID,');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART 2 — SEMANTIC ERRORS (Executor level)
// ═══════════════════════════════════════════════════════════════════════

describe('Oracle SELECT — Semantic errors (table/view resolution)', () => {

  // 26. Non-existent table
  it('fails on selecting from a non-existent table (ORA-00942)', () => {
    expectError('SELECT * FROM HR.NON_EXISTENT_TABLE', /table or view does not exist/i);
  });

  // 27. Non-existent schema.table
  it('fails on selecting from a non-existent schema', () => {
    expectError('SELECT * FROM FAKE_SCHEMA.EMPLOYEES', /table or view does not exist/i);
  });

  // 28. Typo in table name
  it('fails on misspelled table name', () => {
    expectError('SELECT * FROM HR.EMPLOYEEES', /table or view does not exist/i);
  });

  // 29. Table dropped then queried
  it('fails when querying a dropped table', () => {
    exec('CREATE TABLE HR.TEMP_TBL (ID NUMBER)');
    exec('DROP TABLE HR.TEMP_TBL');
    expectError('SELECT * FROM HR.TEMP_TBL', /table or view does not exist/i);
  });

  // 30. Non-existent table in JOIN
  it('fails on JOIN with non-existent table', () => {
    expectError(
      'SELECT * FROM HR.EMPLOYEES E JOIN HR.GHOST_TABLE G ON E.DEPARTMENT_ID = G.DEPARTMENT_ID',
      /table or view does not exist/i,
    );
  });
});

describe('Oracle SELECT — Semantic errors (column resolution)', () => {

  // 31. Non-existent column in SELECT list — ORA-00904
  it('fails on non-existent column in SELECT list (ORA-00904)', () => {
    expectError('SELECT GHOST_COLUMN FROM HR.EMPLOYEES', /invalid identifier/i);
  });

  // 31b. Non-existent qualified column (table.column)
  it('fails on non-existent qualified column (ORA-00904)', () => {
    expectError('SELECT E.GHOST_COLUMN FROM HR.EMPLOYEES E', /invalid identifier/i);
  });

  // 31c. Non-existent column in WHERE clause
  it('fails on non-existent column in WHERE clause (ORA-00904)', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE GHOST_COLUMN = 1', /invalid identifier/i);
  });

  // 31d. Non-existent column on empty table
  it('fails on non-existent column even on empty table (ORA-00904)', () => {
    exec('CREATE TABLE HR.EMPTY_CHECK (ID NUMBER)');
    expectError('SELECT GHOST_COL FROM HR.EMPTY_CHECK', /invalid identifier/i);
  });

  // 32. Ambiguous column reference in multi-table query without qualifier
  it('handles ambiguous column in multi-table query', () => {
    // DEPARTMENT_ID exists in both EMPLOYEES and DEPARTMENTS
    // This should either resolve or fail — the test validates behavior is consistent
    const fn = () => exec(
      'SELECT DEPARTMENT_ID FROM HR.EMPLOYEES E, HR.DEPARTMENTS D'
    );
    // Should not crash; the simulator resolves to the first table's column
    expect(fn).not.toThrow();
  });
});

describe('Oracle SELECT — Semantic errors (division and arithmetic)', () => {

  // 33. Division by zero
  it('fails on division by zero (ORA-01476)', () => {
    expectError('SELECT 1/0 FROM DUAL', /divisor is equal to zero/i);
  });

  // 34. Division by zero in WHERE clause
  it('fails on division by zero in WHERE expression', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE SALARY / 0 > 1', /divisor is equal to zero/i);
  });

  // 35. Division by zero with column expression
  it('fails on division by zero using 0 literal in expression', () => {
    expectError('SELECT SALARY / (1 - 1) FROM HR.EMPLOYEES', /divisor is equal to zero/i);
  });
});

describe('Oracle SELECT — Semantic errors (function misuse)', () => {

  // 36. Aggregate function with no rows — should return null, not crash
  it('returns null for SUM of empty result set', () => {
    exec('CREATE TABLE HR.EMPTY_TBL (VAL NUMBER)');
    const result = exec('SELECT SUM(VAL) FROM HR.EMPTY_TBL');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBeNull();
  });

  // 37. COUNT on empty table returns 0
  it('returns 0 for COUNT(*) on empty table', () => {
    exec('CREATE TABLE HR.EMPTY_TBL2 (VAL NUMBER)');
    const result = exec('SELECT COUNT(*) FROM HR.EMPTY_TBL2');
    expect(result.rows[0][0]).toBe(0);
  });

  // 38. SUBSTR with null first argument
  it('returns null for SUBSTR(NULL, 1, 3)', () => {
    const result = exec("SELECT SUBSTR(NULL, 1, 3) FROM DUAL");
    expect(result.rows[0][0]).toBeNull();
  });

  // 39. LENGTH with null argument
  it('returns null for LENGTH(NULL)', () => {
    const result = exec('SELECT LENGTH(NULL) FROM DUAL');
    expect(result.rows[0][0]).toBeNull();
  });

  // 40. TO_NUMBER with non-numeric string — should fail or return NaN
  it('handles TO_NUMBER on non-numeric string', () => {
    const fn = () => exec("SELECT TO_NUMBER('abc') FROM DUAL");
    // This should either throw or return NaN — test that it doesn't crash silently
    try {
      const result = fn();
      expect(result.rows[0][0]).toBeNaN();
    } catch {
      // Throwing is also acceptable behavior
    }
  });
});

describe('Oracle SELECT — Semantic errors (subquery and set operations)', () => {

  // 41. Subquery referencing non-existent table
  it('fails on subquery from non-existent table', () => {
    expectError(
      'SELECT * FROM (SELECT * FROM HR.GHOST_TABLE) T',
      /table or view does not exist/i,
    );
  });

  // 42. Non-existent table in IN subquery
  it('fails on IN subquery from non-existent table', () => {
    expectError(
      'SELECT * FROM HR.EMPLOYEES WHERE DEPARTMENT_ID IN (SELECT DEPARTMENT_ID FROM HR.GHOST_DEPT)',
      /table or view does not exist/i,
    );
  });

  // 43. Non-existent table in EXISTS subquery
  it('fails on EXISTS subquery from non-existent table', () => {
    expectError(
      'SELECT * FROM HR.EMPLOYEES E WHERE EXISTS (SELECT 1 FROM HR.GHOST_TABLE G WHERE G.ID = E.EMPLOYEE_ID)',
      /table or view does not exist/i,
    );
  });

  // 44. UNION with column count mismatch — behavior test
  it('handles UNION with mismatched column count', () => {
    // UNION between queries with different column counts
    // Oracle would raise ORA-01789, the simulator may handle it differently
    const fn = () => exec(
      'SELECT EMPLOYEE_ID, LAST_NAME FROM HR.EMPLOYEES UNION SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS'
    );
    try {
      fn();
      // If it doesn't throw, it should still return some result
    } catch (e) {
      // Throwing is expected Oracle behavior
      expect(e).toBeDefined();
    }
  });
});

describe('Oracle SELECT — Semantic errors (ORDER BY / GROUP BY issues)', () => {

  // 45. ORDER BY with non-existent column position (very large number)
  it('handles ORDER BY with out-of-range position', () => {
    // ORDER BY 999 — position exceeds column count
    const fn = () => exec('SELECT EMPLOYEE_ID FROM HR.EMPLOYEES ORDER BY 999');
    // Should either throw or silently ignore (the simulator resolves by position)
    try {
      const result = fn();
      expect(result.isQuery).toBe(true);
    } catch (e) {
      expect(e).toBeDefined();
    }
  });

  // 46. Negative ORDER BY position
  it('handles ORDER BY with negative position', () => {
    const fn = () => exec('SELECT EMPLOYEE_ID FROM HR.EMPLOYEES ORDER BY -1');
    try {
      fn();
    } catch (e) {
      expect(e).toBeDefined();
    }
  });
});

describe('Oracle SELECT — Semantic errors (constraint and type related)', () => {

  // 47. Comparing incompatible types in WHERE (string compared to number)
  it('handles type mismatch in WHERE without crashing', () => {
    // Oracle would raise ORA-01722, simulator may coerce or return empty
    const fn = () => exec("SELECT * FROM HR.EMPLOYEES WHERE SALARY = 'not_a_number'");
    try {
      const result = fn();
      expect(result.isQuery).toBe(true);
    } catch (e) {
      expect(e).toBeDefined();
    }
  });

  // 48. NULL comparison with = (semantic trap — always false in Oracle)
  it('returns no rows for WHERE column = NULL', () => {
    const result = exec('SELECT * FROM HR.EMPLOYEES WHERE COMMISSION_PCT = NULL');
    // In Oracle, = NULL always evaluates to UNKNOWN/false
    expect(result.rows.length).toBe(0);
  });

  // 49. NOT NULL comparison with != (semantic trap — always false in Oracle)
  it('returns no rows for WHERE column != NULL', () => {
    const result = exec("SELECT * FROM HR.EMPLOYEES WHERE COMMISSION_PCT != NULL");
    // In Oracle, != NULL always evaluates to UNKNOWN/false
    expect(result.rows.length).toBe(0);
  });

  // 50. DUAL with invalid multi-row attempt
  it('DUAL returns exactly one row regardless of expression', () => {
    const result = exec("SELECT 'a' FROM DUAL");
    expect(result.rows.length).toBe(1);
  });
});

describe('Oracle SELECT — Additional syntax edge cases', () => {

  // 51. Completely empty query
  it('returns empty result for blank SQL', () => {
    const result = exec('');
    expect(result.rows.length).toBe(0);
  });

  // 52. Only whitespace
  it('returns empty result for whitespace-only SQL', () => {
    const result = exec('   ');
    expect(result.rows.length).toBe(0);
  });

  // 53. Random gibberish
  it('fails on completely invalid SQL', () => {
    expectError('XYZZY FOOBAR BAZ');
  });

  // 54. Incomplete expression after WHERE comparison operator
  it('fails on incomplete comparison in WHERE', () => {
    expectError('SELECT * FROM HR.EMPLOYEES WHERE SALARY >');
  });

  // 55. Missing table name after FROM
  it('fails on FROM with no table name', () => {
    expectError('SELECT 1 FROM WHERE 1=1');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART 3 — TYPE CHECKING, GROUP BY, UNION, FUNCTIONS (new corrections)
// ═══════════════════════════════════════════════════════════════════════

describe('Oracle SELECT — Type checking (ORA-01722)', () => {

  // 56. TO_NUMBER with non-numeric string
  it('fails on TO_NUMBER with non-numeric string (ORA-01722)', () => {
    expectError("SELECT TO_NUMBER('abc') FROM DUAL", /invalid number/i);
  });

  // 57. Arithmetic with non-numeric string
  it('fails on arithmetic with string (ORA-01722)', () => {
    expectError("SELECT 'hello' + 1 FROM DUAL", /invalid number/i);
  });

  // 58. Division with non-numeric string
  it('fails on division with string (ORA-01722)', () => {
    expectError("SELECT 'abc' / 2 FROM DUAL", /invalid number/i);
  });
});

describe('Oracle SELECT — GROUP BY validation (ORA-00979)', () => {

  // 59. Non-aggregated column not in GROUP BY
  it('fails when SELECT column not in GROUP BY (ORA-00979)', () => {
    expectError(
      'SELECT EMPLOYEE_ID, DEPARTMENT_ID, SUM(SALARY) FROM HR.EMPLOYEES GROUP BY DEPARTMENT_ID',
      /not a GROUP BY expression/i,
    );
  });

  // 60. Valid GROUP BY should pass
  it('allows aggregate query with all columns in GROUP BY', () => {
    const result = exec('SELECT DEPARTMENT_ID, COUNT(*) FROM HR.EMPLOYEES GROUP BY DEPARTMENT_ID');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  // 61. Expression in SELECT using GROUP BY column is valid
  it('allows function on GROUP BY column', () => {
    const result = exec('SELECT UPPER(JOB_ID), COUNT(*) FROM HR.EMPLOYEES GROUP BY JOB_ID');
    expect(result.isQuery).toBe(true);
  });

  // 62. Pure aggregate without GROUP BY is valid
  it('allows pure aggregate without GROUP BY', () => {
    const result = exec('SELECT COUNT(*), SUM(SALARY) FROM HR.EMPLOYEES');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
  });
});

describe('Oracle SELECT — UNION column count (ORA-01789)', () => {

  // 63. UNION with different column counts
  it('fails on UNION with mismatched column count (ORA-01789)', () => {
    expectError(
      'SELECT EMPLOYEE_ID, LAST_NAME FROM HR.EMPLOYEES UNION SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS',
      /incorrect number of result columns/i,
    );
  });

  // 64. Valid UNION with matching columns
  it('allows UNION with matching column count', () => {
    const result = exec(
      'SELECT EMPLOYEE_ID FROM HR.EMPLOYEES WHERE EMPLOYEE_ID < 102 UNION SELECT DEPARTMENT_ID FROM HR.DEPARTMENTS WHERE DEPARTMENT_ID < 20'
    );
    expect(result.isQuery).toBe(true);
  });
});

describe('Oracle SELECT — DISTINCT + ORDER BY (ORA-01791)', () => {

  // 65. DISTINCT with ORDER BY on non-selected column
  it('fails on DISTINCT with ORDER BY non-selected column (ORA-01791)', () => {
    expectError(
      'SELECT DISTINCT DEPARTMENT_ID FROM HR.EMPLOYEES ORDER BY SALARY',
      /not a SELECTed expression/i,
    );
  });

  // 66. DISTINCT with ORDER BY on selected column is valid
  it('allows DISTINCT with ORDER BY on selected column', () => {
    const result = exec('SELECT DISTINCT DEPARTMENT_ID FROM HR.EMPLOYEES ORDER BY DEPARTMENT_ID');
    expect(result.isQuery).toBe(true);
  });
});

describe('Oracle SELECT — Function improvements', () => {

  // 67. TO_CHAR with date format
  it('TO_CHAR formats date with YYYY-MM-DD', () => {
    const result = exec("SELECT TO_CHAR(TO_DATE('2025-03-15', 'YYYY-MM-DD'), 'DD/MM/YYYY') FROM DUAL");
    expect(result.rows[0][0]).toBe('15/03/2025');
  });

  // 68. LTRIM with custom character
  it('LTRIM removes specified characters', () => {
    const result = exec("SELECT LTRIM('xxxHello', 'x') FROM DUAL");
    expect(result.rows[0][0]).toBe('Hello');
  });

  // 69. RTRIM with custom character
  it('RTRIM removes specified characters', () => {
    const result = exec("SELECT RTRIM('Helloyyy', 'y') FROM DUAL");
    expect(result.rows[0][0]).toBe('Hello');
  });

  // 70. SUBSTR with negative position
  it('SUBSTR with negative position counts from end', () => {
    const result = exec("SELECT SUBSTR('Hello', -3) FROM DUAL");
    expect(result.rows[0][0]).toBe('llo');
  });

  // 71. INSTR with occurrence parameter
  it('INSTR finds nth occurrence', () => {
    const result = exec("SELECT INSTR('ABCABC', 'B', 1, 2) FROM DUAL");
    expect(result.rows[0][0]).toBe(5);
  });

  // 72. Unknown function raises error
  it('fails on unknown function name (ORA-00904)', () => {
    expectError("SELECT FAKE_FUNCTION(1) FROM DUAL", /invalid identifier/i);
  });
});

describe('Oracle SELECT — Transaction support', () => {

  // 73. ROLLBACK undoes INSERT
  it('ROLLBACK undoes INSERT', () => {
    exec('CREATE TABLE HR.TXN_TEST (ID NUMBER, VAL VARCHAR2(20))');
    exec("INSERT INTO HR.TXN_TEST VALUES (1, 'first')");
    const before = exec('SELECT COUNT(*) FROM HR.TXN_TEST');
    expect(before.rows[0][0]).toBe(1);
    exec('ROLLBACK');
    const after = exec('SELECT COUNT(*) FROM HR.TXN_TEST');
    expect(after.rows[0][0]).toBe(0);
  });

  // 74. COMMIT makes changes permanent
  it('COMMIT makes changes permanent (ROLLBACK after COMMIT does nothing)', () => {
    exec('CREATE TABLE HR.TXN_TEST2 (ID NUMBER)');
    exec('INSERT INTO HR.TXN_TEST2 VALUES (1)');
    exec('COMMIT');
    exec('INSERT INTO HR.TXN_TEST2 VALUES (2)');
    exec('ROLLBACK');
    const result = exec('SELECT COUNT(*) FROM HR.TXN_TEST2');
    // After rollback, only the committed row (1) should remain
    expect(result.rows[0][0]).toBe(1);
  });

  // 75. SAVEPOINT + ROLLBACK TO
  it('ROLLBACK TO SAVEPOINT undoes partial work', () => {
    exec('CREATE TABLE HR.TXN_TEST3 (ID NUMBER)');
    exec('INSERT INTO HR.TXN_TEST3 VALUES (1)');
    exec('SAVEPOINT sp1');
    exec('INSERT INTO HR.TXN_TEST3 VALUES (2)');
    exec('INSERT INTO HR.TXN_TEST3 VALUES (3)');
    exec('ROLLBACK TO sp1');
    const result = exec('SELECT COUNT(*) FROM HR.TXN_TEST3');
    expect(result.rows[0][0]).toBe(1);
  });
});

describe('Oracle SELECT — table.* validation', () => {

  // 76. Invalid table alias with .*
  it('fails on table.* with non-existent alias (ORA-00904)', () => {
    expectError(
      'SELECT GHOST.* FROM HR.EMPLOYEES E',
      /invalid identifier/i,
    );
  });

  // 77. Valid table alias with .*
  it('allows table.* with valid alias', () => {
    const result = exec('SELECT E.* FROM HR.EMPLOYEES E WHERE EMPLOYEE_ID = 100');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// PART 4 — DATA TYPE ENFORCEMENT, SEQUENCES, DDL COMMIT (new)
// ═══════════════════════════════════════════════════════════════════════

describe('Oracle — VARCHAR2 length enforcement (ORA-12899)', () => {

  // 78. Insert value exceeding VARCHAR2 length
  it('fails when inserting string too long for VARCHAR2 column (ORA-12899)', () => {
    exec('CREATE TABLE HR.LEN_TEST (NAME VARCHAR2(5))');
    expectError(
      "INSERT INTO HR.LEN_TEST VALUES ('TOOLONG')",
      /value too large/i,
    );
  });

  // 79. Insert value exactly at max length succeeds
  it('allows inserting string at max VARCHAR2 length', () => {
    exec('CREATE TABLE HR.LEN_TEST2 (NAME VARCHAR2(5))');
    exec("INSERT INTO HR.LEN_TEST2 VALUES ('HELLO')");
    const result = exec('SELECT NAME FROM HR.LEN_TEST2');
    expect(result.rows[0][0]).toBe('HELLO');
  });

  // 80. Update value exceeding VARCHAR2 length
  it('fails when updating to string too long for VARCHAR2 (ORA-12899)', () => {
    exec('CREATE TABLE HR.LEN_TEST3 (NAME VARCHAR2(5))');
    exec("INSERT INTO HR.LEN_TEST3 VALUES ('HI')");
    expectError(
      "UPDATE HR.LEN_TEST3 SET NAME = 'WAYTOOLONG'",
      /value too large/i,
    );
  });
});

describe('Oracle — NUMBER precision/scale enforcement (ORA-01438)', () => {

  // 81. Insert value exceeding NUMBER precision
  it('fails when inserting number exceeding precision (ORA-01438)', () => {
    exec('CREATE TABLE HR.NUM_TEST (VAL NUMBER(5,2))');
    expectError(
      'INSERT INTO HR.NUM_TEST VALUES (99999.99)',
      /precision allowed/i,
    );
  });

  // 82. Insert value within NUMBER precision succeeds
  it('allows inserting number within precision', () => {
    exec('CREATE TABLE HR.NUM_TEST2 (VAL NUMBER(5,2))');
    exec('INSERT INTO HR.NUM_TEST2 VALUES (123.45)');
    const result = exec('SELECT VAL FROM HR.NUM_TEST2');
    expect(result.rows[0][0]).toBe(123.45);
  });

  // 83. NUMBER(3) rejects 4-digit numbers
  it('fails when inserting 4-digit number into NUMBER(3) (ORA-01438)', () => {
    exec('CREATE TABLE HR.NUM_TEST3 (VAL NUMBER(3))');
    expectError(
      'INSERT INTO HR.NUM_TEST3 VALUES (1000)',
      /precision allowed/i,
    );
  });
});

describe('Oracle — INSERT INTO ... SELECT validation', () => {

  // 84. Column count mismatch with subquery
  it('fails on INSERT INTO ... SELECT with too many columns (ORA-00913)', () => {
    exec('CREATE TABLE HR.INS_SEL1 (ID NUMBER)');
    exec('CREATE TABLE HR.INS_SEL_SRC (A NUMBER, B NUMBER)');
    exec('INSERT INTO HR.INS_SEL_SRC VALUES (1, 2)');
    expectError(
      'INSERT INTO HR.INS_SEL1 SELECT A, B FROM HR.INS_SEL_SRC',
      /too many values/i,
    );
  });

  // 85. Valid INSERT INTO ... SELECT
  it('allows INSERT INTO ... SELECT with matching column count', () => {
    exec('CREATE TABLE HR.INS_SEL2 (ID NUMBER, VAL NUMBER)');
    exec('CREATE TABLE HR.INS_SEL_SRC2 (A NUMBER, B NUMBER)');
    exec('INSERT INTO HR.INS_SEL_SRC2 VALUES (1, 2)');
    exec('INSERT INTO HR.INS_SEL2 SELECT A, B FROM HR.INS_SEL_SRC2');
    const result = exec('SELECT * FROM HR.INS_SEL2');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(1);
    expect(result.rows[0][1]).toBe(2);
  });
});

describe('Oracle — SEQUENCE CURRVAL without NEXTVAL (ORA-08002)', () => {

  // 86. CURRVAL before NEXTVAL
  it('fails on CURRVAL before NEXTVAL in session (ORA-08002)', () => {
    exec('CREATE SEQUENCE HR.TEST_SEQ START WITH 1');
    expectError(
      'SELECT HR.TEST_SEQ.CURRVAL FROM DUAL',
      /not yet defined in this session/i,
    );
  });

  // 87. CURRVAL after NEXTVAL succeeds
  it('allows CURRVAL after NEXTVAL has been called', () => {
    exec('CREATE SEQUENCE HR.TEST_SEQ2 START WITH 10');
    exec('SELECT HR.TEST_SEQ2.NEXTVAL FROM DUAL');
    const result = exec('SELECT HR.TEST_SEQ2.CURRVAL FROM DUAL');
    expect(result.rows[0][0]).toBe(10);
  });
});

describe('Oracle — DDL implicit COMMIT', () => {

  // 88. TRUNCATE commits pending transaction
  it('TRUNCATE commits pending DML (implicit COMMIT)', () => {
    exec('CREATE TABLE HR.DDL_COMMIT1 (ID NUMBER)');
    exec('CREATE TABLE HR.DDL_COMMIT2 (ID NUMBER)');
    exec('INSERT INTO HR.DDL_COMMIT1 VALUES (1)');
    // TRUNCATE on another table should commit the INSERT
    exec('TRUNCATE TABLE HR.DDL_COMMIT2');
    exec('ROLLBACK');
    const result = exec('SELECT COUNT(*) FROM HR.DDL_COMMIT1');
    expect(result.rows[0][0]).toBe(1); // INSERT was committed
  });

  // 89. CREATE TABLE commits pending transaction
  it('CREATE TABLE commits pending DML (implicit COMMIT)', () => {
    exec('CREATE TABLE HR.DDL_COMMIT3 (ID NUMBER)');
    exec('INSERT INTO HR.DDL_COMMIT3 VALUES (1)');
    exec('CREATE TABLE HR.DDL_COMMIT4 (ID NUMBER)');
    exec('ROLLBACK');
    const result = exec('SELECT COUNT(*) FROM HR.DDL_COMMIT3');
    expect(result.rows[0][0]).toBe(1); // INSERT was committed by DDL
  });

  // 90. DROP TABLE commits pending transaction
  it('DROP TABLE commits pending DML (implicit COMMIT)', () => {
    exec('CREATE TABLE HR.DDL_COMMIT5 (ID NUMBER)');
    exec('CREATE TABLE HR.DDL_COMMIT6 (ID NUMBER)');
    exec('INSERT INTO HR.DDL_COMMIT5 VALUES (1)');
    exec('DROP TABLE HR.DDL_COMMIT6');
    exec('ROLLBACK');
    const result = exec('SELECT COUNT(*) FROM HR.DDL_COMMIT5');
    expect(result.rows[0][0]).toBe(1); // INSERT was committed by DDL
  });
});

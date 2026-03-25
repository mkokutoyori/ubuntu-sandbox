import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;
let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
  db.executeSql(executor, "CREATE TABLE emp_test (empno NUMBER, ename VARCHAR2(50), sal NUMBER)");
});

function exec(sql: string) { return db.executeSql(executor, sql); }

describe('Function-based indexes', () => {
  test('CREATE INDEX with UPPER() succeeds', () => {
    const result = exec('CREATE INDEX idx_upper ON emp_test (UPPER(ename))');
    expect(result.message).toContain('Index created');
  });

  test('CREATE INDEX with LOWER() succeeds', () => {
    const result = exec('CREATE INDEX idx_lower ON emp_test (LOWER(ename))');
    expect(result.message).toContain('Index created');
  });

  test('CREATE INDEX with mixed function and plain columns', () => {
    const result = exec('CREATE INDEX idx_multi ON emp_test (UPPER(ename), sal)');
    expect(result.message).toContain('Index created');
  });

  test('Index appears in DBA_INDEXES view', () => {
    exec('CREATE INDEX idx_upper ON emp_test (UPPER(ename))');
    const result = exec("SELECT INDEX_NAME, TABLE_NAME, INDEX_TYPE FROM DBA_INDEXES WHERE INDEX_NAME = 'IDX_UPPER'");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe('IDX_UPPER');
    expect(result.rows[0][1]).toBe('EMP_TEST');
    expect(result.rows[0][2]).toBe('FUNCTION-BASED NORMAL');
  });

  test('Index columns appear in DBA_IND_COLUMNS with expression info', () => {
    exec('CREATE INDEX idx_upper ON emp_test (UPPER(ename))');
    const result = exec("SELECT COLUMN_NAME, COLUMN_EXPRESSION FROM DBA_IND_COLUMNS WHERE INDEX_NAME = 'IDX_UPPER'");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe('UPPER(ENAME)');
    expect(result.rows[0][1]).toBe('UPPER(ENAME)');
  });

  test('DROP INDEX works on function-based index', () => {
    exec('CREATE INDEX idx_upper ON emp_test (UPPER(ename))');
    const result = exec('DROP INDEX idx_upper');
    expect(result.message).toContain('Index dropped');
    const check = exec("SELECT INDEX_NAME FROM DBA_INDEXES WHERE INDEX_NAME = 'IDX_UPPER'");
    expect(check.rows.length).toBe(0);
  });

  test('ALTER INDEX REBUILD works on function-based index', () => {
    exec('CREATE INDEX idx_upper ON emp_test (UPPER(ename))');
    const result = exec('ALTER INDEX idx_upper REBUILD');
    expect(result.message).toContain('altered');
  });

  test('Mixed index shows expression only for function columns in DBA_IND_COLUMNS', () => {
    exec('CREATE INDEX idx_multi ON emp_test (UPPER(ename), sal)');
    const result = exec("SELECT COLUMN_NAME, COLUMN_EXPRESSION, COLUMN_POSITION FROM DBA_IND_COLUMNS WHERE INDEX_NAME = 'IDX_MULTI' ORDER BY COLUMN_POSITION");
    expect(result.rows.length).toBe(2);
    // First column: function-based
    expect(result.rows[0][0]).toBe('UPPER(ENAME)');
    expect(result.rows[0][1]).toBe('UPPER(ENAME)');
    // Second column: plain
    expect(result.rows[1][0]).toBe('SAL');
    expect(result.rows[1][1]).toBeNull();
  });
});

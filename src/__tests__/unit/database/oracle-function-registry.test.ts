import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { createDefaultSqlFunctionRegistry, SqlFunctionRegistry } from '../../../database/oracle/functions';

let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
let db: OracleDatabase;

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

function scalar(sql: string) {
  return exec(sql).rows[0][0];
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  executor = db.connectAsSysdba().executor;
});

describe('SqlFunctionRegistry', () => {
  test('resolves unqualified names case-insensitively', () => {
    const registry = createDefaultSqlFunctionRegistry();
    expect(registry.has('upper')).toBe(true);
    expect(registry.has('UPPER')).toBe(true);
  });

  test('resolves package-qualified names', () => {
    const registry = createDefaultSqlFunctionRegistry();
    expect(registry.has('VALUE', 'DBMS_RANDOM')).toBe(true);
    expect(registry.has('VALUE')).toBe(false);
  });

  test('custom functions can be registered', () => {
    const registry = new SqlFunctionRegistry();
    registry.register('MY_FUNC', () => 42);
    expect(registry.resolve('my_func')!([], null as never)).toBe(42);
  });
});

describe('String functions through SQL', () => {
  test('SUBSTR with negative start counts from end', () => {
    expect(scalar(`SELECT SUBSTR('ORACLE', -3) FROM DUAL`)).toBe('CLE');
  });

  test('SUBSTR with start 0 behaves as 1', () => {
    expect(scalar(`SELECT SUBSTR('ORACLE', 0, 3) FROM DUAL`)).toBe('ORA');
  });

  test('INSTR finds nth occurrence', () => {
    expect(scalar(`SELECT INSTR('BANANA', 'A', 1, 2) FROM DUAL`)).toBe(4);
  });

  test('INSTR with negative position searches backwards', () => {
    expect(scalar(`SELECT INSTR('BANANA', 'A', -1) FROM DUAL`)).toBe(6);
  });

  test('LENGTH of NULL is NULL', () => {
    expect(scalar(`SELECT LENGTH(NULL) FROM DUAL`)).toBeNull();
  });
});

describe('NULL-handling functions through SQL', () => {
  test('NVL returns substitute for NULL', () => {
    expect(scalar(`SELECT NVL(NULL, 'X') FROM DUAL`)).toBe('X');
  });

  test('NULLIF returns NULL on equality', () => {
    expect(scalar(`SELECT NULLIF(5, 5) FROM DUAL`)).toBeNull();
  });

  test('DECODE matches and falls back to default', () => {
    expect(scalar(`SELECT DECODE(2, 1, 'one', 2, 'two', 'other') FROM DUAL`)).toBe('two');
    expect(scalar(`SELECT DECODE(9, 1, 'one', 2, 'two', 'other') FROM DUAL`)).toBe('other');
  });
});

describe('GREATEST / LEAST Oracle NULL semantics', () => {
  test('GREATEST returns NULL when any argument is NULL', () => {
    expect(scalar(`SELECT GREATEST(1, NULL, 3) FROM DUAL`)).toBeNull();
  });

  test('LEAST returns NULL when any argument is NULL', () => {
    expect(scalar(`SELECT LEAST(NULL, 5) FROM DUAL`)).toBeNull();
  });

  test('GREATEST returns the maximum of non-null arguments', () => {
    expect(scalar(`SELECT GREATEST(1, 7, 3) FROM DUAL`)).toBe(7);
  });

  test('LEAST returns the minimum of non-null arguments', () => {
    expect(scalar(`SELECT LEAST(4, 2, 9) FROM DUAL`)).toBe(2);
  });
});

describe('Unknown functions raise ORA-00904', () => {
  test('unknown unqualified function', () => {
    expect(() => exec(`SELECT NO_SUCH_FUNC(1) FROM DUAL`)).toThrow(/ORA-00904/);
  });

  test('unqualified package-only function name', () => {
    expect(() => exec(`SELECT GATHER_TABLE_STATS('A') FROM DUAL`)).toThrow(/ORA-00904/);
  });

  test('qualified call on unknown package', () => {
    expect(() => exec(`SELECT NO_PKG.UPPER('x') FROM DUAL`)).toThrow(/ORA-00904/);
  });
});

describe('Oracle padding and case semantics', () => {
  test('LPAD truncates when string exceeds target length', () => {
    expect(scalar(`SELECT LPAD('hello', 3) FROM DUAL`)).toBe('hel');
  });

  test('RPAD truncates when string exceeds target length', () => {
    expect(scalar(`SELECT RPAD('hello', 2, '*') FROM DUAL`)).toBe('he');
  });

  test('LPAD with non-positive length returns NULL', () => {
    expect(scalar(`SELECT LPAD('x', 0) FROM DUAL`)).toBeNull();
  });

  test('LPAD fills with repeating pad string', () => {
    expect(scalar(`SELECT LPAD('7', 5, 'ab') FROM DUAL`)).toBe('abab7');
  });

  test('INITCAP lowercases the rest of each word', () => {
    expect(scalar(`SELECT INITCAP('heLLo woRLD') FROM DUAL`)).toBe('Hello World');
  });

  test('INITCAP treats non-alphanumeric characters as word boundaries', () => {
    expect(scalar(`SELECT INITCAP('jean-pierre') FROM DUAL`)).toBe('Jean-Pierre');
  });

  test('ASCII of empty string is NULL', () => {
    expect(scalar(`SELECT ASCII('') FROM DUAL`)).toBeNull();
  });
});

describe('Oracle numeric edge semantics', () => {
  test('MOD with zero divisor returns the dividend', () => {
    expect(scalar(`SELECT MOD(7, 0) FROM DUAL`)).toBe(7);
  });

  test('REMAINDER uses round-half-even quotient', () => {
    expect(scalar(`SELECT REMAINDER(10, 3) FROM DUAL`)).toBe(1);
  });

  test('REMAINDER with zero divisor returns NULL', () => {
    expect(scalar(`SELECT REMAINDER(10, 0) FROM DUAL`)).toBeNull();
  });
});

describe('Package functions through SQL', () => {
  test('DBMS_LOB.GETLENGTH returns string length', () => {
    expect(scalar(`SELECT DBMS_LOB.GETLENGTH('hello') FROM DUAL`)).toBe(5);
  });

  test('DBMS_UTILITY.GET_TIME returns a number', () => {
    expect(typeof scalar(`SELECT DBMS_UTILITY.GET_TIME() FROM DUAL`)).toBe('number');
  });
});

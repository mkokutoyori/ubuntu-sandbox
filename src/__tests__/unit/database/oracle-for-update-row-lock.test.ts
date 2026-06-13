import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;
let a: ReturnType<OracleDatabase['connectAsSysdba']>;
let b: ReturnType<OracleDatabase['connectAsSysdba']>;

const sql = (c: typeof a, q: string) => db.executeSql(c.executor, q);
const tryRun = (c: typeof a, q: string): string => {
  try { sql(c, q); return 'OK'; } catch (e) { return e instanceof Error ? e.message : String(e); }
};

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  a = db.connectAsSysdba();
  sql(a, 'CREATE TABLE hr.t (id NUMBER PRIMARY KEY, v VARCHAR2(10))');
  sql(a, "INSERT INTO hr.t VALUES (1, 'x')");
  sql(a, "INSERT INTO hr.t VALUES (2, 'y')");
  sql(a, 'COMMIT');
  b = db.connectAsSysdba();
});

describe('SELECT … FOR UPDATE takes row-level locks across sessions', () => {
  it('another session gets ORA-00054 on the SAME locked row with NOWAIT', () => {
    sql(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE');
    expect(tryRun(b, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE NOWAIT')).toMatch(/ORA-00054/);
  });

  it('a DIFFERENT row is not blocked (row-level, not table-level)', () => {
    sql(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE');
    expect(tryRun(b, 'SELECT * FROM hr.t WHERE id = 2 FOR UPDATE NOWAIT')).toBe('OK');
  });

  it('SKIP LOCKED returns only the rows that are free', () => {
    sql(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE');
    const res = sql(b, 'SELECT id FROM hr.t FOR UPDATE SKIP LOCKED');
    expect(res.rows.map(r => r[0])).toEqual([2]);
  });

  it('a commit releases the locks for other sessions', () => {
    sql(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE');
    expect(tryRun(b, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE NOWAIT')).toMatch(/ORA-00054/);
    sql(a, 'COMMIT');
    expect(tryRun(b, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE NOWAIT')).toBe('OK');
  });

  it('a rollback releases the locks too', () => {
    sql(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE');
    sql(a, 'ROLLBACK');
    expect(tryRun(b, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE NOWAIT')).toBe('OK');
  });

  it('the same session re-locking its own row is fine (re-entrant)', () => {
    sql(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE');
    expect(tryRun(a, 'SELECT * FROM hr.t WHERE id = 1 FOR UPDATE NOWAIT')).toBe('OK');
  });
});

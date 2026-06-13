import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;

beforeEach(() => {
  db = new OracleDatabase();
});

function execAt(state: 'NOMOUNT' | 'MOUNT' | 'OPEN', sql: string): string {
  db.instance.startup(state === 'OPEN' ? 'OPEN' : state);
  const { executor } = db.connectAsSysdba();
  try {
    db.executeSql(executor, sql);
    return 'OK';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

describe('schema DML/DDL requires the database to be OPEN (ORA-01109)', () => {
  it('CREATE TABLE in MOUNT is rejected', () => {
    expect(execAt('MOUNT', 'CREATE TABLE hr.t (id NUMBER)')).toMatch(/ORA-01109/);
  });

  it('INSERT in MOUNT is rejected', () => {
    expect(execAt('MOUNT', 'INSERT INTO hr.t VALUES (1)')).toMatch(/ORA-01109/);
  });

  it('CREATE INDEX in NOMOUNT is rejected', () => {
    expect(execAt('NOMOUNT', 'CREATE INDEX hr.i ON hr.t (id)')).toMatch(/ORA-01109/);
  });

  it('CREATE TABLESPACE in MOUNT is rejected', () => {
    expect(execAt('MOUNT', "CREATE TABLESPACE x DATAFILE '/u01/x.dbf' SIZE 10M"))
      .toMatch(/ORA-01109/);
  });

  it('the same DDL succeeds once the database is OPEN', () => {
    expect(execAt('OPEN', 'CREATE TABLE hr.t (id NUMBER)')).toBe('OK');
  });
});

describe('instance-control statements still work before OPEN', () => {
  it('ALTER DATABASE OPEN is allowed from MOUNT', () => {
    db.instance.startup('MOUNT');
    const { executor } = db.connectAsSysdba();
    expect(() => db.executeSql(executor, 'ALTER DATABASE OPEN')).not.toThrow();
    expect(db.instance.state).toBe('OPEN');
  });
});

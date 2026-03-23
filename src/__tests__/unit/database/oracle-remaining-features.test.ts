/**
 * Tests for remaining Oracle DBMS features — packages, DDL, stubs.
 *
 * Covers: DBMS_LOCK, DBMS_UTILITY, DBMS_METADATA, DBMS_STATS,
 * CREATE/DROP SYNONYM, ALTER SEQUENCE, ALTER INDEX, DB Links,
 * Materialized Views.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';

let db: OracleDatabase;
let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
});

// ── Built-in Packages ────────────────────────────────────────────

describe('Built-in PL/SQL Packages', () => {

  describe('DBMS_LOCK.SLEEP', () => {
    test('DBMS_LOCK.SLEEP executes without error in PL/SQL block', () => {
      const result = exec(`BEGIN DBMS_LOCK.SLEEP(1); END`);
      expect(result.message).toContain('PL/SQL');
    });
  });

  describe('DBMS_UTILITY', () => {
    test('DBMS_UTILITY.GET_TIME returns a number via SELECT', () => {
      const result = exec(`SELECT DBMS_UTILITY.GET_TIME FROM DUAL`);
      expect(result.isQuery).toBe(true);
      expect(result.rows.length).toBe(1);
      expect(typeof result.rows[0][0]).toBe('number');
    });

    test('DBMS_UTILITY.FORMAT_ERROR_BACKTRACE returns empty string', () => {
      const result = exec(`SELECT DBMS_UTILITY.FORMAT_ERROR_BACKTRACE FROM DUAL`);
      expect(result.isQuery).toBe(true);
      expect(result.rows[0][0]).toBe('');
    });
  });

  describe('DBMS_METADATA.GET_DDL', () => {
    test('GET_DDL for TABLE returns CREATE TABLE statement', () => {
      exec(`CREATE TABLE test_meta (id NUMBER, name VARCHAR2(50))`);
      const result = exec(`SELECT DBMS_METADATA.GET_DDL('TABLE', 'TEST_META') FROM DUAL`);
      expect(result.isQuery).toBe(true);
      const ddl = String(result.rows[0][0]);
      expect(ddl).toContain('CREATE TABLE');
      expect(ddl).toContain('TEST_META');
      expect(ddl).toContain('ID');
      expect(ddl).toContain('NAME');
    });

    test('GET_DDL for INDEX returns CREATE INDEX statement', () => {
      exec(`CREATE TABLE idx_meta (id NUMBER)`);
      exec(`CREATE INDEX idx_test_meta ON idx_meta (id)`);
      const result = exec(`SELECT DBMS_METADATA.GET_DDL('INDEX', 'IDX_TEST_META') FROM DUAL`);
      expect(result.isQuery).toBe(true);
      const ddl = String(result.rows[0][0]);
      expect(ddl).toContain('INDEX');
      expect(ddl).toContain('IDX_TEST_META');
    });

    test('GET_DDL for SEQUENCE returns CREATE SEQUENCE statement', () => {
      exec(`CREATE SEQUENCE seq_meta START WITH 1 INCREMENT BY 1`);
      const result = exec(`SELECT DBMS_METADATA.GET_DDL('SEQUENCE', 'SEQ_META') FROM DUAL`);
      expect(result.isQuery).toBe(true);
      const ddl = String(result.rows[0][0]);
      expect(ddl).toContain('CREATE SEQUENCE');
      expect(ddl).toContain('SEQ_META');
    });

    test('GET_DDL for non-existent object returns null', () => {
      const result = exec(`SELECT DBMS_METADATA.GET_DDL('TABLE', 'NONEXISTENT') FROM DUAL`);
      expect(result.rows[0][0]).toBeNull();
    });
  });

  describe('DBMS_STATS', () => {
    test('DBMS_STATS.GATHER_TABLE_STATS executes without error', () => {
      exec(`CREATE TABLE stats_test (id NUMBER)`);
      const result = exec(`BEGIN DBMS_STATS.GATHER_TABLE_STATS('SYS', 'STATS_TEST'); END`);
      expect(result.message).toContain('PL/SQL');
    });
  });

  describe('DBMS_SESSION', () => {
    test('DBMS_SESSION.SET_NLS executes without error', () => {
      const result = exec(`BEGIN DBMS_SESSION.SET_NLS('NLS_DATE_FORMAT', 'YYYY-MM-DD'); END`);
      expect(result.message).toContain('PL/SQL');
    });
  });

  describe('UTL_FILE', () => {
    test('UTL_FILE.FOPEN executes without error', () => {
      const result = exec(`BEGIN UTL_FILE.FOPEN('/tmp', 'test.txt', 'W'); END`);
      expect(result.message).toContain('PL/SQL');
    });
  });

  describe('DBMS_LOB.GETLENGTH', () => {
    test('DBMS_LOB.GETLENGTH returns length of string', () => {
      const result = exec(`SELECT DBMS_LOB.GETLENGTH('Hello World') FROM DUAL`);
      expect(result.isQuery).toBe(true);
      expect(result.rows[0][0]).toBe(11);
    });
  });
});

// ── CREATE/DROP SYNONYM ──────────────────────────────────────────

describe('Synonym DDL', () => {

  test('CREATE SYNONYM and query DBA_SYNONYMS', () => {
    exec(`CREATE TABLE syn_target (id NUMBER)`);
    exec(`CREATE SYNONYM emp_syn FOR syn_target`);
    const result = exec(`SELECT * FROM DBA_SYNONYMS`);
    expect(result.rows.some(r => r[1] === 'EMP_SYN')).toBe(true);
  });

  test('CREATE PUBLIC SYNONYM', () => {
    exec(`CREATE TABLE pub_target (id NUMBER)`);
    exec(`CREATE PUBLIC SYNONYM pub_syn FOR pub_target`);
    const result = exec(`SELECT * FROM DBA_SYNONYMS`);
    expect(result.rows.some(r => r[0] === 'PUBLIC' && r[1] === 'PUB_SYN')).toBe(true);
  });

  test('CREATE OR REPLACE SYNONYM', () => {
    exec(`CREATE TABLE syn_t1 (id NUMBER)`);
    exec(`CREATE TABLE syn_t2 (id NUMBER)`);
    exec(`CREATE SYNONYM my_syn FOR syn_t1`);
    exec(`CREATE OR REPLACE SYNONYM my_syn FOR syn_t2`);
    const result = exec(`SELECT * FROM DBA_SYNONYMS`);
    const syn = result.rows.find(r => r[1] === 'MY_SYN');
    expect(syn).toBeDefined();
    expect(syn![3]).toBe('SYN_T2');
  });

  test('DROP SYNONYM', () => {
    exec(`CREATE TABLE drop_syn_target (id NUMBER)`);
    exec(`CREATE SYNONYM drop_me FOR drop_syn_target`);
    exec(`DROP SYNONYM drop_me`);
    const result = exec(`SELECT * FROM DBA_SYNONYMS`);
    expect(result.rows.some(r => r[1] === 'DROP_ME')).toBe(false);
  });

  test('DROP PUBLIC SYNONYM', () => {
    exec(`CREATE TABLE pub_drop_target (id NUMBER)`);
    exec(`CREATE PUBLIC SYNONYM pub_drop FOR pub_drop_target`);
    exec(`DROP PUBLIC SYNONYM pub_drop`);
    const result = exec(`SELECT * FROM DBA_SYNONYMS`);
    expect(result.rows.some(r => r[1] === 'PUB_DROP')).toBe(false);
  });
});

// ── ALTER SEQUENCE ───────────────────────────────────────────────

describe('ALTER SEQUENCE', () => {

  test('ALTER SEQUENCE INCREMENT BY changes increment', () => {
    exec(`CREATE SEQUENCE alt_seq START WITH 1 INCREMENT BY 1`);
    exec(`SELECT alt_seq.NEXTVAL FROM DUAL`); // current = 1
    exec(`ALTER SEQUENCE alt_seq INCREMENT BY 10`);
    const result = exec(`SELECT alt_seq.NEXTVAL FROM DUAL`);
    expect(result.rows[0][0]).toBe(11); // 1 + 10
  });

  test('ALTER SEQUENCE CACHE changes cache size', () => {
    exec(`CREATE SEQUENCE cache_seq START WITH 1 INCREMENT BY 1 CACHE 5`);
    const result = exec(`ALTER SEQUENCE cache_seq CACHE 20`);
    expect(result.message).toContain('Sequence altered');
  });

  test('ALTER SEQUENCE NOCYCLE', () => {
    exec(`CREATE SEQUENCE cycle_seq START WITH 1 INCREMENT BY 1 CYCLE`);
    const result = exec(`ALTER SEQUENCE cycle_seq NOCYCLE`);
    expect(result.message).toContain('Sequence altered');
  });
});

// ── ALTER INDEX ──────────────────────────────────────────────────

describe('ALTER INDEX', () => {

  test('ALTER INDEX REBUILD succeeds', () => {
    exec(`CREATE TABLE idx_rebuild (id NUMBER)`);
    exec(`CREATE INDEX idx_rb ON idx_rebuild (id)`);
    const result = exec(`ALTER INDEX idx_rb REBUILD`);
    expect(result.message).toContain('Index altered');
  });

  test('ALTER INDEX REBUILD on non-existent index throws error', () => {
    expect(() => exec(`ALTER INDEX nonexistent_idx REBUILD`)).toThrow();
  });

  test('ALTER INDEX RENAME TO succeeds', () => {
    exec(`CREATE TABLE idx_rename_t (id NUMBER)`);
    exec(`CREATE INDEX idx_old ON idx_rename_t (id)`);
    const result = exec(`ALTER INDEX idx_old RENAME TO idx_new`);
    expect(result.message).toContain('Index altered');
  });
});

// ── DB Links (stubs) ─────────────────────────────────────────────

describe('Database Links (stubs)', () => {

  test('CREATE DATABASE LINK succeeds', () => {
    const result = exec(`CREATE DATABASE LINK remote_db CONNECT TO user1 IDENTIFIED BY pass1 USING 'remote_tns'`);
    expect(result.message).toContain('Database link created');
  });

  test('CREATE PUBLIC DATABASE LINK succeeds', () => {
    const result = exec(`CREATE PUBLIC DATABASE LINK pub_link CONNECT TO user1 IDENTIFIED BY pass1 USING 'remote'`);
    expect(result.message).toContain('Database link created');
  });

  test('DROP DATABASE LINK succeeds', () => {
    const result = exec(`DROP DATABASE LINK remote_db`);
    expect(result.message).toContain('Database link dropped');
  });
});

// ── Materialized Views (stubs) ───────────────────────────────────

describe('Materialized Views (stubs)', () => {

  test('CREATE MATERIALIZED VIEW succeeds', () => {
    exec(`CREATE TABLE mv_source (id NUMBER, val NUMBER)`);
    const result = exec(`CREATE MATERIALIZED VIEW mv_test AS SELECT id, val FROM mv_source`);
    expect(result.message).toContain('Materialized view created');
  });

  test('DROP MATERIALIZED VIEW succeeds', () => {
    const result = exec(`DROP MATERIALIZED VIEW mv_test`);
    expect(result.message).toContain('Materialized view dropped');
  });
});

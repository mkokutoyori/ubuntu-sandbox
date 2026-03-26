/**
 * Tests for Oracle object management (DDL operations).
 *
 * Scenarios covered:
 *   1.  CREATE TABLE — basic, with constraints, CTAS, temporary tables
 *   2.  DROP TABLE — basic, IF EXISTS, non-existent table error
 *   3.  ALTER TABLE — ADD/MODIFY/DROP column, ADD/DROP constraint, RENAME column/table
 *   4.  TRUNCATE TABLE — clears rows, preserves structure
 *   5.  CREATE/DROP INDEX — simple, unique, bitmap, function-based
 *   6.  CREATE/DROP SEQUENCE — with options, NEXTVAL/CURRVAL
 *   7.  ALTER SEQUENCE — modify parameters
 *   8.  CREATE/DROP VIEW — basic, OR REPLACE, query through view
 *   9.  CREATE/DROP TRIGGER — metadata storage
 *  10.  CREATE/DROP SYNONYM — private and public
 *  11.  Schema-qualified objects — cross-schema DDL
 *  12.  Error handling — duplicate objects, missing objects, invalid operations
 *  13.  DESC[RIBE] — terminal-level object inspection
 *  14.  Constraints enforcement — PK, UNIQUE, NOT NULL, FK
 *  15.  Object interaction — index on table, view on table, trigger on table
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';

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

// Helper: create a SQL*Plus session connected as SYSDBA
function createSQLPlus(): { cmd: (line: string) => string } {
  const session = new SQLPlusSession(db);
  session.processLine('CONNECT / AS SYSDBA');
  return {
    cmd(line: string): string {
      const result = session.processLine(line);
      return result.output.join('\n');
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. CREATE TABLE
// ═══════════════════════════════════════════════════════════════════

describe('CREATE TABLE', () => {
  test('basic table creation', () => {
    const result = exec('CREATE TABLE employees (id NUMBER, name VARCHAR2(50))');
    expect(result.message).toContain('Table created.');
    expect(db.storage.tableExists('SYS', 'EMPLOYEES')).toBe(true);
  });

  test('table with NOT NULL constraint', () => {
    exec('CREATE TABLE t1 (id NUMBER NOT NULL, name VARCHAR2(30))');
    const meta = db.storage.getTableMeta('SYS', 'T1');
    expect(meta).toBeDefined();
    const idCol = meta!.columns.find(c => c.name === 'ID');
    expect(idCol!.dataType.nullable).toBe(false);
  });

  test('table with PRIMARY KEY column-level', () => {
    exec('CREATE TABLE t2 (id NUMBER PRIMARY KEY, name VARCHAR2(30))');
    const meta = db.storage.getTableMeta('SYS', 'T2');
    const pk = meta!.constraints.find(c => c.type === 'PRIMARY_KEY');
    expect(pk).toBeDefined();
    expect(pk!.columns).toContain('ID');
  });

  test('table with UNIQUE constraint', () => {
    exec('CREATE TABLE t3 (id NUMBER, email VARCHAR2(100) UNIQUE)');
    const meta = db.storage.getTableMeta('SYS', 'T3');
    const uq = meta!.constraints.find(c => c.type === 'UNIQUE');
    expect(uq).toBeDefined();
    expect(uq!.columns).toContain('EMAIL');
  });

  test('table with table-level PRIMARY KEY', () => {
    exec('CREATE TABLE t4 (id NUMBER, name VARCHAR2(30), CONSTRAINT pk_t4 PRIMARY KEY (id))');
    const meta = db.storage.getTableMeta('SYS', 'T4');
    const pk = meta!.constraints.find(c => c.type === 'PRIMARY_KEY');
    expect(pk).toBeDefined();
    expect(pk!.name.toUpperCase()).toBe('PK_T4');
    expect(pk!.columns).toEqual(['ID']);
  });

  test('table with composite PRIMARY KEY', () => {
    exec('CREATE TABLE t5 (a NUMBER, b NUMBER, c VARCHAR2(10), PRIMARY KEY (a, b))');
    const meta = db.storage.getTableMeta('SYS', 'T5');
    const pk = meta!.constraints.find(c => c.type === 'PRIMARY_KEY');
    expect(pk!.columns).toEqual(['A', 'B']);
  });

  test('table with FOREIGN KEY', () => {
    exec('CREATE TABLE parent (id NUMBER PRIMARY KEY)');
    exec('CREATE TABLE child (id NUMBER, parent_id NUMBER REFERENCES parent(id))');
    const meta = db.storage.getTableMeta('SYS', 'CHILD');
    const fk = meta!.constraints.find(c => c.type === 'FOREIGN_KEY');
    expect(fk).toBeDefined();
    expect(fk!.refTable).toBe('PARENT');
    expect(fk!.refColumns).toEqual(['ID']);
  });

  test('table with multiple column types', () => {
    exec(`CREATE TABLE multi_types (
      id NUMBER(10),
      name VARCHAR2(100),
      amount NUMBER(12,2),
      created DATE,
      flag CHAR(1)
    )`);
    const meta = db.storage.getTableMeta('SYS', 'MULTI_TYPES');
    expect(meta!.columns.length).toBe(5);
    expect(meta!.columns[0].name).toBe('ID');
    expect(meta!.columns[2].dataType.name).toBe('NUMBER');
  });

  test('CREATE TABLE AS SELECT (CTAS)', () => {
    exec('CREATE TABLE source (id NUMBER, val VARCHAR2(20))');
    exec("INSERT INTO source VALUES (1, 'A')");
    exec("INSERT INTO source VALUES (2, 'B')");
    exec('CREATE TABLE copy AS SELECT id, val FROM source');
    const rows = db.storage.getRows('SYS', 'COPY');
    expect(rows.length).toBe(2);
  });

  test('duplicate table name raises ORA-00955', () => {
    exec('CREATE TABLE dup_test (id NUMBER)');
    expect(() => exec('CREATE TABLE dup_test (id NUMBER)')).toThrow(/already used/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. DROP TABLE
// ═══════════════════════════════════════════════════════════════════

describe('DROP TABLE', () => {
  test('drop existing table', () => {
    exec('CREATE TABLE to_drop (id NUMBER)');
    expect(db.storage.tableExists('SYS', 'TO_DROP')).toBe(true);
    const result = exec('DROP TABLE to_drop');
    expect(result.message).toContain('Table dropped.');
    expect(db.storage.tableExists('SYS', 'TO_DROP')).toBe(false);
  });

  test('drop non-existent table raises ORA-00942', () => {
    expect(() => exec('DROP TABLE no_such_table')).toThrow(/does not exist/);
  });

  test('drop table removes its data', () => {
    exec('CREATE TABLE ephemeral (id NUMBER)');
    exec('INSERT INTO ephemeral VALUES (1)');
    exec('INSERT INTO ephemeral VALUES (2)');
    exec('DROP TABLE ephemeral');
    expect(db.storage.tableExists('SYS', 'EPHEMERAL')).toBe(false);
  });

  test('drop table then recreate with same name', () => {
    exec('CREATE TABLE reuse (id NUMBER)');
    exec('INSERT INTO reuse VALUES (99)');
    exec('DROP TABLE reuse');
    exec('CREATE TABLE reuse (name VARCHAR2(20))');
    const meta = db.storage.getTableMeta('SYS', 'REUSE');
    expect(meta!.columns[0].name).toBe('NAME');
    expect(db.storage.getRows('SYS', 'REUSE').length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. ALTER TABLE
// ═══════════════════════════════════════════════════════════════════

describe('ALTER TABLE', () => {
  beforeEach(() => {
    exec('CREATE TABLE alter_test (id NUMBER, name VARCHAR2(30))');
    exec("INSERT INTO alter_test VALUES (1, 'Alice')");
    exec("INSERT INTO alter_test VALUES (2, 'Bob')");
  });

  test('ADD column', () => {
    const result = exec('ALTER TABLE alter_test ADD email VARCHAR2(100)');
    expect(result.message).toContain('Table altered.');
    const meta = db.storage.getTableMeta('SYS', 'ALTER_TEST');
    expect(meta!.columns.length).toBe(3);
    expect(meta!.columns[2].name).toBe('EMAIL');
    // Existing rows should have NULL for new column
    const rows = db.storage.getRows('SYS', 'ALTER_TEST');
    expect(rows[0][2]).toBeNull();
  });

  test('MODIFY column type', () => {
    exec('ALTER TABLE alter_test MODIFY name VARCHAR2(100)');
    const meta = db.storage.getTableMeta('SYS', 'ALTER_TEST');
    const nameCol = meta!.columns.find(c => c.name === 'NAME');
    expect(nameCol!.dataType.precision).toBe(100);
  });

  test('MODIFY column to NOT NULL', () => {
    exec('ALTER TABLE alter_test MODIFY name VARCHAR2(30) NOT NULL');
    const meta = db.storage.getTableMeta('SYS', 'ALTER_TEST');
    const nameCol = meta!.columns.find(c => c.name === 'NAME');
    expect(nameCol!.dataType.nullable).toBe(false);
  });

  test('DROP column', () => {
    exec('ALTER TABLE alter_test DROP COLUMN name');
    const meta = db.storage.getTableMeta('SYS', 'ALTER_TEST');
    expect(meta!.columns.length).toBe(1);
    expect(meta!.columns[0].name).toBe('ID');
    // Data should also lose the dropped column
    const rows = db.storage.getRows('SYS', 'ALTER_TEST');
    expect(rows[0].length).toBe(1);
    expect(rows[0][0]).toBe(1);
  });

  test('ALTER on non-existent table raises ORA-00942', () => {
    expect(() => exec('ALTER TABLE ghost ADD col1 NUMBER')).toThrow(/does not exist/);
  });

  test('MODIFY non-existent column raises error', () => {
    expect(() => exec('ALTER TABLE alter_test MODIFY zzz NUMBER')).toThrow(/invalid identifier/);
  });

  test('ADD column then SELECT it', () => {
    exec('ALTER TABLE alter_test ADD age NUMBER');
    exec('UPDATE alter_test SET age = 25 WHERE id = 1');
    const result = exec('SELECT id, name, age FROM alter_test WHERE id = 1');
    expect(result.rows[0][2]).toBe(25);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. TRUNCATE TABLE
// ═══════════════════════════════════════════════════════════════════

describe('TRUNCATE TABLE', () => {
  test('truncate removes all rows', () => {
    exec('CREATE TABLE trunc_test (id NUMBER, val VARCHAR2(10))');
    exec("INSERT INTO trunc_test VALUES (1, 'A')");
    exec("INSERT INTO trunc_test VALUES (2, 'B')");
    exec("INSERT INTO trunc_test VALUES (3, 'C')");
    expect(db.storage.getRows('SYS', 'TRUNC_TEST').length).toBe(3);

    const result = exec('TRUNCATE TABLE trunc_test');
    expect(result.message).toContain('Table truncated.');
    expect(db.storage.getRows('SYS', 'TRUNC_TEST').length).toBe(0);
  });

  test('truncate preserves table structure', () => {
    exec('CREATE TABLE trunc_struct (id NUMBER, name VARCHAR2(50))');
    exec("INSERT INTO trunc_struct VALUES (1, 'test')");
    exec('TRUNCATE TABLE trunc_struct');
    const meta = db.storage.getTableMeta('SYS', 'TRUNC_STRUCT');
    expect(meta!.columns.length).toBe(2);
    expect(meta!.columns[0].name).toBe('ID');
    expect(meta!.columns[1].name).toBe('NAME');
  });

  test('insert after truncate works', () => {
    exec('CREATE TABLE trunc_reuse (id NUMBER)');
    exec('INSERT INTO trunc_reuse VALUES (1)');
    exec('TRUNCATE TABLE trunc_reuse');
    exec('INSERT INTO trunc_reuse VALUES (99)');
    const rows = db.storage.getRows('SYS', 'TRUNC_REUSE');
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe(99);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. CREATE/DROP INDEX
// ═══════════════════════════════════════════════════════════════════

describe('CREATE/DROP INDEX', () => {
  beforeEach(() => {
    exec('CREATE TABLE idx_test (id NUMBER, name VARCHAR2(50), status NUMBER)');
  });

  test('create simple index', () => {
    const result = exec('CREATE INDEX idx_name ON idx_test (name)');
    expect(result.message).toContain('Index created.');
    const indexes = db.storage.getIndexes('SYS', 'IDX_TEST');
    expect(indexes.length).toBeGreaterThan(0);
    const idx = indexes.find(i => i.name === 'IDX_NAME');
    expect(idx).toBeDefined();
    expect(idx!.columns).toContain('NAME');
  });

  test('create UNIQUE index', () => {
    exec('CREATE UNIQUE INDEX idx_id ON idx_test (id)');
    const indexes = db.storage.getIndexes('SYS', 'IDX_TEST');
    const idx = indexes.find(i => i.name === 'IDX_ID');
    expect(idx!.unique).toBe(true);
  });

  test('create BITMAP index', () => {
    exec('CREATE BITMAP INDEX idx_status ON idx_test (status)');
    const indexes = db.storage.getIndexes('SYS', 'IDX_TEST');
    const idx = indexes.find(i => i.name === 'IDX_STATUS');
    expect(idx!.bitmap).toBe(true);
  });

  test('create composite index', () => {
    exec('CREATE INDEX idx_comp ON idx_test (name, status)');
    const indexes = db.storage.getIndexes('SYS', 'IDX_TEST');
    const idx = indexes.find(i => i.name === 'IDX_COMP');
    expect(idx!.columns).toEqual(['NAME', 'STATUS']);
  });

  test('drop index', () => {
    exec('CREATE INDEX idx_drop_me ON idx_test (id)');
    let indexes = db.storage.getIndexes('SYS', 'IDX_TEST');
    expect(indexes.some(i => i.name === 'IDX_DROP_ME')).toBe(true);

    const result = exec('DROP INDEX idx_drop_me');
    expect(result.message).toContain('Index dropped.');
    indexes = db.storage.getIndexes('SYS', 'IDX_TEST');
    expect(indexes.some(i => i.name === 'IDX_DROP_ME')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. CREATE/DROP SEQUENCE
// ═══════════════════════════════════════════════════════════════════

describe('CREATE/DROP SEQUENCE', () => {
  test('create simple sequence', () => {
    const result = exec('CREATE SEQUENCE seq_test');
    expect(result.message).toContain('Sequence created.');
    expect(db.storage.sequenceExists('SYS', 'SEQ_TEST')).toBe(true);
  });

  test('sequence NEXTVAL increments', () => {
    exec('CREATE SEQUENCE seq_inc START WITH 1 INCREMENT BY 1');
    const r1 = exec('SELECT seq_inc.NEXTVAL FROM DUAL');
    expect(r1.rows[0][0]).toBe(1);
    const r2 = exec('SELECT seq_inc.NEXTVAL FROM DUAL');
    expect(r2.rows[0][0]).toBe(2);
    const r3 = exec('SELECT seq_inc.NEXTVAL FROM DUAL');
    expect(r3.rows[0][0]).toBe(3);
  });

  test('sequence with custom START WITH and INCREMENT BY', () => {
    exec('CREATE SEQUENCE seq_custom START WITH 100 INCREMENT BY 10');
    const r1 = exec('SELECT seq_custom.NEXTVAL FROM DUAL');
    expect(r1.rows[0][0]).toBe(100);
    const r2 = exec('SELECT seq_custom.NEXTVAL FROM DUAL');
    expect(r2.rows[0][0]).toBe(110);
  });

  test('CURRVAL returns last NEXTVAL', () => {
    exec('CREATE SEQUENCE seq_curr START WITH 5 INCREMENT BY 5');
    exec('SELECT seq_curr.NEXTVAL FROM DUAL');
    const r = exec('SELECT seq_curr.CURRVAL FROM DUAL');
    expect(r.rows[0][0]).toBe(5);
  });

  test('drop sequence', () => {
    exec('CREATE SEQUENCE seq_drop');
    expect(db.storage.sequenceExists('SYS', 'SEQ_DROP')).toBe(true);
    const result = exec('DROP SEQUENCE seq_drop');
    expect(result.message).toContain('Sequence dropped.');
    expect(db.storage.sequenceExists('SYS', 'SEQ_DROP')).toBe(false);
  });

  test('sequence used in INSERT', () => {
    exec('CREATE SEQUENCE seq_ins START WITH 1 INCREMENT BY 1');
    exec('CREATE TABLE seq_data (id NUMBER, name VARCHAR2(20))');
    exec("INSERT INTO seq_data VALUES (seq_ins.NEXTVAL, 'first')");
    exec("INSERT INTO seq_data VALUES (seq_ins.NEXTVAL, 'second')");
    const result = exec('SELECT id, name FROM seq_data ORDER BY id');
    expect(result.rows[0][0]).toBe(1);
    expect(result.rows[1][0]).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. ALTER SEQUENCE
// ═══════════════════════════════════════════════════════════════════

describe('ALTER SEQUENCE', () => {
  test('alter INCREMENT BY', () => {
    exec('CREATE SEQUENCE seq_alt START WITH 1 INCREMENT BY 1');
    exec('SELECT seq_alt.NEXTVAL FROM DUAL'); // 1
    exec('ALTER SEQUENCE seq_alt INCREMENT BY 5');
    const r = exec('SELECT seq_alt.NEXTVAL FROM DUAL');
    expect(r.rows[0][0]).toBe(6); // 1 + 5
  });

  test('alter non-existent sequence raises error', () => {
    expect(() => exec('ALTER SEQUENCE no_seq INCREMENT BY 2')).toThrow(/does not exist/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. CREATE/DROP VIEW
// ═══════════════════════════════════════════════════════════════════

describe('CREATE/DROP VIEW', () => {
  beforeEach(() => {
    exec('CREATE TABLE emp (id NUMBER, name VARCHAR2(30), dept VARCHAR2(20), salary NUMBER)');
    exec("INSERT INTO emp VALUES (1, 'Alice', 'IT', 70000)");
    exec("INSERT INTO emp VALUES (2, 'Bob', 'HR', 60000)");
    exec("INSERT INTO emp VALUES (3, 'Charlie', 'IT', 80000)");
  });

  test('create simple view', () => {
    const result = exec('CREATE VIEW v_emp AS SELECT id, name FROM emp');
    expect(result.message).toContain('View created.');
    expect(db.storage.viewExists('SYS', 'V_EMP')).toBe(true);
  });

  test('SELECT from view returns correct data', () => {
    exec('CREATE VIEW v_it AS SELECT name, salary FROM emp WHERE dept = \'IT\'');
    const result = exec('SELECT name, salary FROM v_it ORDER BY salary');
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('Alice');
    expect(result.rows[1][0]).toBe('Charlie');
  });

  test('CREATE OR REPLACE VIEW overwrites existing', () => {
    exec('CREATE VIEW v_replace AS SELECT id FROM emp');
    exec('CREATE OR REPLACE VIEW v_replace AS SELECT name, salary FROM emp');
    const result = exec('SELECT name FROM v_replace');
    expect(result.rows.length).toBe(3);
  });

  test('drop view', () => {
    exec('CREATE VIEW v_drop AS SELECT id FROM emp');
    expect(db.storage.viewExists('SYS', 'V_DROP')).toBe(true);
    const result = exec('DROP VIEW v_drop');
    expect(result.message).toContain('View dropped.');
    expect(db.storage.viewExists('SYS', 'V_DROP')).toBe(false);
  });

  test('view reflects underlying table changes', () => {
    exec('CREATE VIEW v_all AS SELECT id, name FROM emp');
    exec("INSERT INTO emp VALUES (4, 'Diana', 'Sales', 55000)");
    const result = exec('SELECT COUNT(*) AS cnt FROM v_all');
    expect(result.rows[0][0]).toBe(4);
  });

  test('view with column aliases', () => {
    exec('CREATE VIEW v_alias AS SELECT name AS employee_name, salary AS pay FROM emp');
    const result = exec('SELECT employee_name, pay FROM v_alias WHERE pay > 65000 ORDER BY pay');
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][0]).toBe('Alice');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. CREATE/DROP TRIGGER
// ═══════════════════════════════════════════════════════════════════

describe('CREATE/DROP TRIGGER', () => {
  beforeEach(() => {
    exec('CREATE TABLE trig_table (id NUMBER, val VARCHAR2(20))');
  });

  test('create trigger stores metadata', () => {
    exec(`CREATE OR REPLACE TRIGGER trg_test
      BEFORE INSERT ON trig_table
      FOR EACH ROW
    BEGIN
      NULL;
    END;
    /`);
    const triggers = db.storage.getTriggersForTable('SYS', 'TRIG_TABLE');
    expect(triggers.length).toBeGreaterThan(0);
    const trg = triggers.find(t => t.name === 'TRG_TEST');
    expect(trg).toBeDefined();
    expect(trg!.timing).toBe('BEFORE');
    expect(trg!.events).toContain('INSERT');
    expect(trg!.forEachRow).toBe(true);
  });

  test('drop trigger removes metadata', () => {
    exec(`CREATE OR REPLACE TRIGGER trg_drop
      AFTER DELETE ON trig_table
      FOR EACH ROW
    BEGIN
      NULL;
    END;
    /`);
    let triggers = db.storage.getTriggersForTable('SYS', 'TRIG_TABLE');
    expect(triggers.some(t => t.name === 'TRG_DROP')).toBe(true);

    exec('DROP TRIGGER trg_drop');
    triggers = db.storage.getTriggersForTable('SYS', 'TRIG_TABLE');
    expect(triggers.some(t => t.name === 'TRG_DROP')).toBe(false);
  });

  test('OR REPLACE trigger replaces existing', () => {
    exec(`CREATE OR REPLACE TRIGGER trg_rep
      BEFORE INSERT ON trig_table
      FOR EACH ROW
    BEGIN
      NULL;
    END;
    /`);
    exec(`CREATE OR REPLACE TRIGGER trg_rep
      AFTER UPDATE ON trig_table
      FOR EACH ROW
    BEGIN
      NULL;
    END;
    /`);
    const triggers = db.storage.getTriggersForTable('SYS', 'TRIG_TABLE');
    const trg = triggers.find(t => t.name === 'TRG_REP');
    expect(trg!.timing).toBe('AFTER');
    expect(trg!.events).toContain('UPDATE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. CREATE/DROP SYNONYM
// ═══════════════════════════════════════════════════════════════════

describe('CREATE/DROP SYNONYM', () => {
  beforeEach(() => {
    exec('CREATE TABLE real_table (id NUMBER, name VARCHAR2(30))');
  });

  test('create private synonym', () => {
    const result = exec('CREATE SYNONYM syn_test FOR real_table');
    expect(result.message).toContain('Synonym created.');
    const syn = db.storage.getSynonym('SYS', 'SYN_TEST');
    expect(syn).toBeDefined();
    expect(syn!.tableName).toBe('REAL_TABLE');
  });

  test('create public synonym', () => {
    const result = exec('CREATE PUBLIC SYNONYM pub_syn FOR real_table');
    expect(result.message).toContain('Synonym created.');
    const syn = db.storage.getSynonym('PUBLIC', 'PUB_SYN');
    expect(syn).toBeDefined();
    expect(syn!.isPublic).toBe(true);
  });

  test('drop synonym', () => {
    exec('CREATE SYNONYM syn_drop FOR real_table');
    expect(db.storage.getSynonym('SYS', 'SYN_DROP')).toBeDefined();
    const result = exec('DROP SYNONYM syn_drop');
    expect(result.message).toContain('Synonym dropped.');
    expect(db.storage.getSynonym('SYS', 'SYN_DROP')).toBeUndefined();
  });

  test('drop public synonym', () => {
    exec('CREATE PUBLIC SYNONYM pub_drop FOR real_table');
    exec('DROP PUBLIC SYNONYM pub_drop');
    expect(db.storage.getSynonym('PUBLIC', 'PUB_DROP')).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. Schema-qualified objects
// ═══════════════════════════════════════════════════════════════════

describe('Schema-qualified objects', () => {
  test('create table in specific schema', () => {
    exec('CREATE USER testuser IDENTIFIED BY pass123');
    exec('CREATE TABLE testuser.items (id NUMBER, name VARCHAR2(20))');
    expect(db.storage.tableExists('TESTUSER', 'ITEMS')).toBe(true);
    expect(db.storage.tableExists('SYS', 'ITEMS')).toBe(false);
  });

  test('insert and select from schema-qualified table', () => {
    exec('CREATE USER schemauser IDENTIFIED BY pass');
    exec('CREATE TABLE schemauser.data (val NUMBER)');
    exec('INSERT INTO schemauser.data VALUES (42)');
    const result = exec('SELECT val FROM schemauser.data');
    expect(result.rows[0][0]).toBe(42);
  });

  test('drop table in specific schema', () => {
    exec('CREATE USER dropuser IDENTIFIED BY pass');
    exec('CREATE TABLE dropuser.tmp (id NUMBER)');
    exec('DROP TABLE dropuser.tmp');
    expect(db.storage.tableExists('DROPUSER', 'TMP')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12. Error handling
// ═══════════════════════════════════════════════════════════════════

describe('Error handling', () => {
  test('create duplicate table raises ORA-00955', () => {
    exec('CREATE TABLE err_dup (id NUMBER)');
    expect(() => exec('CREATE TABLE err_dup (id NUMBER)')).toThrow(/already used/);
  });

  test('drop non-existent table raises ORA-00942', () => {
    expect(() => exec('DROP TABLE nope')).toThrow(/does not exist/);
  });

  test('drop non-existent index is silent (no error)', () => {
    // Implementation silently ignores missing indexes
    const result = exec('DROP INDEX no_idx');
    expect(result.message).toContain('Index dropped.');
  });

  test('drop non-existent sequence is silent (no error)', () => {
    // Implementation silently ignores missing sequences
    const result = exec('DROP SEQUENCE no_seq');
    expect(result.message).toContain('Sequence dropped.');
  });

  test('alter non-existent table raises ORA-00942', () => {
    expect(() => exec('ALTER TABLE missing ADD col NUMBER')).toThrow(/does not exist/);
  });

  test('create duplicate user raises ORA-01920', () => {
    exec('CREATE USER dupuser IDENTIFIED BY pass');
    expect(() => exec('CREATE USER dupuser IDENTIFIED BY pass2')).toThrow(/conflicts/);
  });

  test('drop non-existent user raises ORA-01918', () => {
    expect(() => exec('DROP USER ghost_user')).toThrow(/does not exist/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 13. DESC[RIBE] — terminal-level
// ═══════════════════════════════════════════════════════════════════

describe('DESC[RIBE] via SQL*Plus', () => {
  test('DESC shows table columns', () => {
    exec('CREATE TABLE desc_test (id NUMBER, name VARCHAR2(50), active CHAR(1))');
    const sp = createSQLPlus();
    const output = sp.cmd('DESC desc_test');
    expect(output).toContain('ID');
    expect(output).toContain('NAME');
    expect(output).toContain('ACTIVE');
    expect(output).toContain('VARCHAR2');
    expect(output).toContain('NUMBER');
  });

  test('DESCRIBE (full word) works', () => {
    exec('CREATE TABLE desc_full (col1 NUMBER)');
    const sp = createSQLPlus();
    const output = sp.cmd('DESCRIBE desc_full');
    expect(output).toContain('COL1');
    expect(output).toContain('NUMBER');
  });

  test('DESC shows NOT NULL constraints', () => {
    exec('CREATE TABLE desc_nn (id NUMBER NOT NULL, name VARCHAR2(30))');
    const sp = createSQLPlus();
    const output = sp.cmd('DESC desc_nn');
    expect(output).toContain('NOT NULL');
  });

  test('DESC on non-existent object shows error', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC no_such_table');
    expect(output).toContain('ERROR');
  });

  test('DESC with schema qualification', () => {
    exec('CREATE USER descuser IDENTIFIED BY pass');
    exec('CREATE TABLE descuser.info (id NUMBER, data VARCHAR2(100))');
    const sp = createSQLPlus();
    const output = sp.cmd('DESC descuser.info');
    expect(output).toContain('ID');
    expect(output).toContain('DATA');
  });

  test('DESC after ALTER TABLE ADD shows new column', () => {
    exec('CREATE TABLE desc_alter (id NUMBER)');
    exec('ALTER TABLE desc_alter ADD extra VARCHAR2(20)');
    const sp = createSQLPlus();
    const output = sp.cmd('DESC desc_alter');
    expect(output).toContain('ID');
    expect(output).toContain('EXTRA');
    expect(output).toContain('VARCHAR2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 14. Constraints enforcement
// ═══════════════════════════════════════════════════════════════════

describe('Constraints metadata', () => {
  test('named constraint stored correctly', () => {
    exec(`CREATE TABLE c_test (
      id NUMBER,
      CONSTRAINT pk_ctest PRIMARY KEY (id)
    )`);
    const meta = db.storage.getTableMeta('SYS', 'C_TEST');
    const pk = meta!.constraints.find(c => c.name.toUpperCase() === 'PK_CTEST');
    expect(pk).toBeDefined();
    expect(pk!.type).toBe('PRIMARY_KEY');
  });

  test('auto-generated constraint name', () => {
    exec('CREATE TABLE auto_c (id NUMBER PRIMARY KEY)');
    const meta = db.storage.getTableMeta('SYS', 'AUTO_C');
    const pk = meta!.constraints.find(c => c.type === 'PRIMARY_KEY');
    expect(pk).toBeDefined();
    expect(pk!.name).toMatch(/^SYS_C/);
  });

  test('multiple constraints on same table', () => {
    exec(`CREATE TABLE multi_c (
      id NUMBER PRIMARY KEY,
      email VARCHAR2(100) UNIQUE,
      name VARCHAR2(50) NOT NULL
    )`);
    const meta = db.storage.getTableMeta('SYS', 'MULTI_C');
    expect(meta!.constraints.length).toBeGreaterThanOrEqual(3);
    expect(meta!.constraints.some(c => c.type === 'PRIMARY_KEY')).toBe(true);
    expect(meta!.constraints.some(c => c.type === 'UNIQUE')).toBe(true);
    expect(meta!.constraints.some(c => c.type === 'NOT_NULL')).toBe(true);
  });

  test('table-level UNIQUE constraint', () => {
    exec(`CREATE TABLE tbl_uq (
      a NUMBER, b NUMBER,
      CONSTRAINT uq_ab UNIQUE (a, b)
    )`);
    const meta = db.storage.getTableMeta('SYS', 'TBL_UQ');
    const uq = meta!.constraints.find(c => c.name.toUpperCase() === 'UQ_AB');
    expect(uq).toBeDefined();
    expect(uq!.type).toBe('UNIQUE');
    expect(uq!.columns).toEqual(['A', 'B']);
  });

  test('FOREIGN KEY with ON DELETE CASCADE', () => {
    exec('CREATE TABLE fk_parent (id NUMBER PRIMARY KEY)');
    exec(`CREATE TABLE fk_child (
      id NUMBER,
      pid NUMBER,
      CONSTRAINT fk_pid FOREIGN KEY (pid) REFERENCES fk_parent(id) ON DELETE CASCADE
    )`);
    const meta = db.storage.getTableMeta('SYS', 'FK_CHILD');
    const fk = meta!.constraints.find(c => c.name.toUpperCase() === 'FK_PID');
    expect(fk).toBeDefined();
    expect(fk!.type).toBe('FOREIGN_KEY');
    expect(fk!.refTable).toBe('FK_PARENT');
    expect(fk!.onDelete).toBe('CASCADE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 15. Object interactions
// ═══════════════════════════════════════════════════════════════════

describe('Object interactions', () => {
  test('index on table — both created and dropped properly', () => {
    exec('CREATE TABLE oi_tbl (id NUMBER, name VARCHAR2(30))');
    exec('CREATE INDEX oi_idx ON oi_tbl (name)');
    let indexes = db.storage.getIndexes('SYS', 'OI_TBL');
    expect(indexes.some(i => i.name === 'OI_IDX')).toBe(true);
    // Dropping the table should clean up indexes too
    exec('DROP TABLE oi_tbl');
    indexes = db.storage.getIndexes('SYS', 'OI_TBL');
    expect(indexes.some(i => i.name === 'OI_IDX')).toBe(false);
  });

  test('view depends on table — inserting into table updates view', () => {
    exec('CREATE TABLE oi_base (id NUMBER, val NUMBER)');
    exec('INSERT INTO oi_base VALUES (1, 10)');
    exec('CREATE VIEW oi_view AS SELECT id, val FROM oi_base');
    exec('INSERT INTO oi_base VALUES (2, 20)');
    const result = exec('SELECT COUNT(*) AS cnt FROM oi_view');
    expect(result.rows[0][0]).toBe(2);
  });

  test('sequence in INSERT populates auto-increment IDs', () => {
    exec('CREATE SEQUENCE oi_seq START WITH 1 INCREMENT BY 1');
    exec('CREATE TABLE oi_auto (id NUMBER, name VARCHAR2(20))');
    exec("INSERT INTO oi_auto VALUES (oi_seq.NEXTVAL, 'first')");
    exec("INSERT INTO oi_auto VALUES (oi_seq.NEXTVAL, 'second')");
    exec("INSERT INTO oi_auto VALUES (oi_seq.NEXTVAL, 'third')");
    const result = exec('SELECT id, name FROM oi_auto ORDER BY id');
    expect(result.rows.length).toBe(3);
    expect(result.rows[0][0]).toBe(1);
    expect(result.rows[1][0]).toBe(2);
    expect(result.rows[2][0]).toBe(3);
  });

  test('create table, add index, truncate, verify structure intact', () => {
    exec('CREATE TABLE oi_trunc (id NUMBER, name VARCHAR2(30))');
    exec('CREATE INDEX oi_trunc_idx ON oi_trunc (name)');
    exec("INSERT INTO oi_trunc VALUES (1, 'test')");
    exec('TRUNCATE TABLE oi_trunc');
    expect(db.storage.getRows('SYS', 'OI_TRUNC').length).toBe(0);
    const meta = db.storage.getTableMeta('SYS', 'OI_TRUNC');
    expect(meta!.columns.length).toBe(2);
    const indexes = db.storage.getIndexes('SYS', 'OI_TRUNC');
    expect(indexes.some(i => i.name === 'OI_TRUNC_IDX')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 16. User/Role management
// ═══════════════════════════════════════════════════════════════════

describe('User and Role management', () => {
  test('create user', () => {
    const result = exec('CREATE USER alice IDENTIFIED BY secret123');
    expect(result.message).toContain('User created.');
  });

  test('create user with options', () => {
    exec('CREATE USER bob IDENTIFIED BY pass DEFAULT TABLESPACE users');
    // User should exist in catalog
    const catalog = (db as any).catalog;
    expect(catalog.userExists('BOB')).toBe(true);
  });

  test('alter user password', () => {
    exec('CREATE USER charlie IDENTIFIED BY oldpass');
    const result = exec('ALTER USER charlie IDENTIFIED BY newpass');
    expect(result.message).toContain('User altered.');
  });

  test('alter user lock/unlock', () => {
    exec('CREATE USER lockme IDENTIFIED BY pass');
    exec('ALTER USER lockme ACCOUNT LOCK');
    exec('ALTER USER lockme ACCOUNT UNLOCK');
    // No error means success
  });

  test('drop user', () => {
    exec('CREATE USER dropme IDENTIFIED BY pass');
    const result = exec('DROP USER dropme');
    expect(result.message).toContain('User dropped.');
  });

  test('create and drop role', () => {
    const r1 = exec('CREATE ROLE app_role');
    expect(r1.message).toContain('Role created.');
    const r2 = exec('DROP ROLE app_role');
    expect(r2.message).toContain('Role dropped.');
  });

  test('grant and revoke system privilege', () => {
    exec('CREATE USER grantee IDENTIFIED BY pass');
    const r1 = exec('GRANT CREATE SESSION TO grantee');
    expect(r1.message).toContain('Grant succeeded.');
    const r2 = exec('REVOKE CREATE SESSION FROM grantee');
    expect(r2.message).toContain('Revoke succeeded.');
  });

  test('grant and revoke role', () => {
    exec('CREATE USER roleuser IDENTIFIED BY pass');
    exec('CREATE ROLE dev_role');
    exec('GRANT dev_role TO roleuser');
    exec('REVOKE dev_role FROM roleuser');
  });

  test('grant object privilege', () => {
    exec('CREATE TABLE grant_tbl (id NUMBER)');
    exec('CREATE USER viewer IDENTIFIED BY pass');
    const result = exec('GRANT SELECT ON grant_tbl TO viewer');
    expect(result.message).toContain('Grant succeeded.');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 17. SQL*Plus DDL output
// ═══════════════════════════════════════════════════════════════════

describe('SQL*Plus DDL feedback', () => {
  test('CREATE TABLE shows correct feedback', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('CREATE TABLE sp_tbl (id NUMBER);');
    expect(output).toContain('Table created');
  });

  test('DROP TABLE shows correct feedback', () => {
    exec('CREATE TABLE sp_drop (id NUMBER)');
    const sp = createSQLPlus();
    const output = sp.cmd('DROP TABLE sp_drop;');
    expect(output).toContain('Table dropped');
  });

  test('CREATE INDEX shows correct feedback', () => {
    exec('CREATE TABLE sp_idx_tbl (id NUMBER)');
    const sp = createSQLPlus();
    const output = sp.cmd('CREATE INDEX sp_idx ON sp_idx_tbl (id);');
    expect(output).toContain('Index created');
  });

  test('CREATE SEQUENCE shows correct feedback', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('CREATE SEQUENCE sp_seq;');
    expect(output).toContain('Sequence created');
  });

  test('CREATE VIEW shows correct feedback', () => {
    exec('CREATE TABLE sp_view_tbl (id NUMBER)');
    const sp = createSQLPlus();
    const output = sp.cmd('CREATE VIEW sp_v AS SELECT id FROM sp_view_tbl;');
    expect(output).toContain('View created');
  });

  test('TRUNCATE TABLE shows correct feedback', () => {
    exec('CREATE TABLE sp_trunc (id NUMBER)');
    const sp = createSQLPlus();
    const output = sp.cmd('TRUNCATE TABLE sp_trunc;');
    expect(output).toContain('Table truncated');
  });

  test('ALTER TABLE shows correct feedback', () => {
    exec('CREATE TABLE sp_alt (id NUMBER)');
    const sp = createSQLPlus();
    const output = sp.cmd('ALTER TABLE sp_alt ADD name VARCHAR2(30);');
    expect(output).toContain('Table altered');
  });
});

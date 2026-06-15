import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let session: SQLPlusSession;
const run = (sql: string) => session.processLine(sql).output.join('\n');

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', '', true);
  run('CREATE TABLE hr.t (id NUMBER, val VARCHAR2(20));');
  run("INSERT INTO hr.t VALUES (1, 'one');");
  run('COMMIT;');
});

const currentScn = () => db.instance.getCurrentScn();

describe('SELECT ... AS OF SCN', () => {
  it('reads the table as it was at a past SCN', () => {
    const scnBefore = currentScn();
    run("UPDATE hr.t SET val = 'uno' WHERE id = 1;");
    run('COMMIT;');
    expect(run('SELECT val FROM hr.t;')).toContain('uno');
    expect(run(`SELECT val FROM hr.t AS OF SCN ${scnBefore};`)).toContain('one');
  });

  it('an SCN with no later change returns the current state', () => {
    const scn = currentScn();
    expect(run(`SELECT val FROM hr.t AS OF SCN ${scn};`)).toContain('one');
  });

  it('sees through several generations', () => {
    const scn0 = currentScn();
    run("INSERT INTO hr.t VALUES (2, 'two');");
    run('COMMIT;');
    const scn1 = currentScn();
    run('DELETE FROM hr.t;');
    run('COMMIT;');
    expect(run('SELECT COUNT(*) FROM hr.t;')).toMatch(/\b0\b/);
    expect(run(`SELECT COUNT(*) FROM hr.t AS OF SCN ${scn1};`)).toMatch(/\b2\b/);
    expect(run(`SELECT COUNT(*) FROM hr.t AS OF SCN ${scn0};`)).toMatch(/\b1\b/);
  });

  it('rejects a non-numeric SCN with ORA-08181', () => {
    expect(run("SELECT * FROM hr.t AS OF SCN 'abc';")).toMatch(/ORA-08181/);
  });
});

describe('FLASHBACK TABLE ... TO SCN', () => {
  it('restores the past content of the table', () => {
    const scnBefore = currentScn();
    run("UPDATE hr.t SET val = 'changed';");
    run("INSERT INTO hr.t VALUES (9, 'nine');");
    run('COMMIT;');
    expect(run('SELECT COUNT(*) FROM hr.t;')).toMatch(/\b2\b/);

    expect(run(`FLASHBACK TABLE hr.t TO SCN ${scnBefore};`)).toContain('Flashback complete');
    const out = run('SELECT id, val FROM hr.t;');
    expect(out).toContain('one');
    expect(out).not.toContain('changed');
    expect(out).not.toContain('nine');
  });

  it('a flashback is itself flashback-able (the pre-image is captured)', () => {
    const scnBefore = currentScn();
    run('DELETE FROM hr.t;');
    run('COMMIT;');
    const scnEmpty = currentScn();
    run(`FLASHBACK TABLE hr.t TO SCN ${scnBefore};`);
    expect(run('SELECT COUNT(*) FROM hr.t;')).toMatch(/\b1\b/);
    run(`FLASHBACK TABLE hr.t TO SCN ${scnEmpty};`);
    expect(run('SELECT COUNT(*) FROM hr.t;')).toMatch(/\b0\b/);
  });

  it('TO BEFORE DROP still restores from the recyclebin', () => {
    run('DROP TABLE hr.t;');
    expect(run('SELECT * FROM hr.t;')).toMatch(/ORA-00942/);
    expect(run('FLASHBACK TABLE hr.t TO BEFORE DROP;')).toContain('Flashback complete');
    expect(run('SELECT val FROM hr.t;')).toContain('one');
  });
});

describe('SELECT ... AS OF TIMESTAMP', () => {
  it('a timestamp in the future of all changes returns the current state', () => {
    run("UPDATE hr.t SET val = 'now';");
    run('COMMIT;');
    expect(run('SELECT val FROM hr.t AS OF TIMESTAMP SYSDATE + 1;')).toContain('now');
  });

  it('a timestamp before every change returns the oldest known image', () => {
    run("UPDATE hr.t SET val = 'now';");
    run('COMMIT;');
    expect(run('SELECT COUNT(*) FROM hr.t AS OF TIMESTAMP SYSDATE - 1;')).toMatch(/\b0\b/);
  });
});

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
});

describe('INSERT … SELECT applies column DEFAULTs for omitted columns', () => {
  it('an omitted column with a DEFAULT gets the default, not NULL', () => {
    run('CREATE TABLE hr.src (id NUMBER);');
    run('INSERT INTO hr.src VALUES (1);');
    run('INSERT INTO hr.src VALUES (2);');
    run("CREATE TABLE hr.dst (id NUMBER, status VARCHAR2(10) DEFAULT 'NEW');");
    run('INSERT INTO hr.dst (id) SELECT id FROM hr.src;');
    const out = run('SELECT id, status FROM hr.dst ORDER BY id;');
    expect(out).toMatch(/1\s+NEW/);
    expect(out).toMatch(/2\s+NEW/);
  });

  it('a NOT NULL column with a DEFAULT does not fail an INSERT … SELECT', () => {
    run('CREATE TABLE hr.src (id NUMBER);');
    run('INSERT INTO hr.src VALUES (1);');
    run("CREATE TABLE hr.dst (id NUMBER, flag NUMBER DEFAULT 0 NOT NULL);");
    expect(run('INSERT INTO hr.dst (id) SELECT id FROM hr.src;')).toContain('1 row created.');
    expect(run('SELECT flag FROM hr.dst;')).toMatch(/\b0\b/);
  });

  it('a plain INSERT with a column list applies the DEFAULT to omitted columns', () => {
    run("CREATE TABLE hr.t (id NUMBER, status VARCHAR2(10) DEFAULT 'NEW');");
    run('INSERT INTO hr.t (id) VALUES (1);');
    expect(run('SELECT status FROM hr.t;')).toContain('NEW');
  });

  it('an explicit NULL is kept (DEFAULT only fills omitted columns)', () => {
    run("CREATE TABLE hr.t (id NUMBER, status VARCHAR2(10) DEFAULT 'NEW');");
    run("INSERT INTO hr.t (id, status) VALUES (1, NULL);");
    const out = run("SELECT id, NVL(status, '<null>') s FROM hr.t;");
    expect(out).toMatch(/<null>/);
    expect(out).not.toMatch(/NEW/);
  });

  it('DEFAULT SYSDATE is evaluated per row', () => {
    run('CREATE TABLE hr.t (id NUMBER, created DATE DEFAULT SYSDATE);');
    run('INSERT INTO hr.t (id) VALUES (1);');
    run('INSERT INTO hr.t (id) VALUES (2);');
    expect(run('SELECT COUNT(*) FROM hr.t WHERE created IS NOT NULL;')).toMatch(/\b2\b/);
  });
});

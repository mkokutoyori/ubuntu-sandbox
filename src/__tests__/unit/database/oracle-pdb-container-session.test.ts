import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

let db: OracleDatabase;
let session: SQLPlusSession;
const run = (sql: string) => session.processLine(sql).output.join('\n');

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', '', true);
});

const conName = () => run("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL;");
const conId = () => run("SELECT SYS_CONTEXT('USERENV','CON_ID') FROM DUAL;");

describe('ALTER SESSION SET CONTAINER moves the session between containers', () => {
  it('starts in CDB$ROOT (CON_ID 1)', () => {
    expect(conName()).toMatch(/CDB\$ROOT/);
    expect(conId()).toMatch(/\b1\b/);
  });

  it('switches into an open PDB and back to root', () => {
    run('ALTER SESSION SET CONTAINER = ORCLPDB1;');
    expect(conName()).toMatch(/ORCLPDB1/);
    expect(conId()).toMatch(/\b3\b/);
    run('ALTER SESSION SET CONTAINER = CDB$ROOT;');
    expect(conName()).toMatch(/CDB\$ROOT/);
  });

  it('SHOW CON_NAME / CON_ID reflect the current container', () => {
    run('ALTER SESSION SET CONTAINER = ORCLPDB1;');
    expect(run('SHOW CON_NAME')).toMatch(/CON_NAME[\s\S]*ORCLPDB1/);
    expect(run('SHOW CON_ID')).toMatch(/CON_ID[\s\S]*\b3\b/);
  });

  it('V$SESSION.CON_ID reflects the live container of the session', () => {
    run('ALTER SESSION SET CONTAINER = ORCLPDB1;');
    const out = run("SELECT con_id FROM v$session WHERE username = 'SYS' AND type = 'USER';");
    expect(out).toMatch(/\b3\b/);
  });

  it('an unknown container raises ORA-65011', () => {
    expect(run('ALTER SESSION SET CONTAINER = NOPE;')).toMatch(/ORA-65011/);
  });

  it('PDB$SEED is not a valid target (ORA-65011)', () => {
    expect(run('ALTER SESSION SET CONTAINER = PDB$SEED;')).toMatch(/ORA-65011/);
  });

  it('a mounted (closed) PDB cannot be entered (ORA-65040)', () => {
    run('CREATE PLUGGABLE DATABASE coldpdb ADMIN USER a IDENTIFIED BY p;');
    expect(run('ALTER SESSION SET CONTAINER = COLDPDB;')).toMatch(/ORA-65040/);
  });
});

describe('connecting through a PDB service lands the session in that PDB', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    resetAllOracleInstances();
    Logger.reset();
  });

  it('sqlplus user/pass@//host/ORCLPDB1 starts in ORCLPDB1', () => {
    const srv = new LinuxServer('linux-server', 'pdbconn', 100, 100);
    SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
    const { subShell } = SqlPlusSubShell.create(srv, ['system/oracle@//localhost/ORCLPDB1']);
    const out = subShell.processLine("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL;").output.join('\n');
    subShell.dispose();
    expect(out).toMatch(/ORCLPDB1/);
  });

  it('connecting to the CDB service (ORCL) stays in CDB$ROOT', () => {
    const srv = new LinuxServer('linux-server', 'cdbconn', 100, 100);
    SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
    const { subShell } = SqlPlusSubShell.create(srv, ['system/oracle@//localhost/ORCL']);
    const out = subShell.processLine("SELECT SYS_CONTEXT('USERENV','CON_NAME') FROM DUAL;").output.join('\n');
    subShell.dispose();
    expect(out).toMatch(/CDB\$ROOT/);
  });
});

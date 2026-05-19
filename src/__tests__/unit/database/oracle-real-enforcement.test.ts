/**
 * Real privilege enforcement — a user without the right grant must
 * not be able to see / modify other schemas' data.
 *
 * The SYSDBA bypass is preserved (real Oracle does the same), but
 * regular sessions go through the full privilege chain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function asSys(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return { srv, sh: SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell };
}

function asUser(srv: LinuxServer, user: string, pass: string) {
  return SqlPlusSubShell.create(srv, [`${user}/${pass}`]).subShell;
}

const run = (sh: { processLine: (l: string) => { output: string[] } }, q: string) =>
  sh.processLine(q).output.join('\n');

describe('SELECT enforcement', () => {
  it('a user with only CONNECT cannot SELECT from another schema', () => {
    const env = asSys('sel-deny');
    run(env.sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CONNECT TO alice;');
    run(env.sh, 'GRANT CREATE SESSION TO alice;');
    env.sh.dispose();

    const alice = asUser(env.srv, 'alice', 'Aa1234');
    const out = run(alice, 'SELECT * FROM hr.employees;');
    expect(out).toMatch(/ORA-00942/);
    alice.dispose();
  });

  it('after GRANT SELECT, the user can read', () => {
    const env = asSys('sel-grant');
    run(env.sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CONNECT TO bob;');
    run(env.sh, 'GRANT CREATE SESSION TO bob;');
    run(env.sh, 'GRANT SELECT ON hr.employees TO bob;');
    env.sh.dispose();

    const bob = asUser(env.srv, 'bob', 'Aa1234');
    const out = run(bob, "SELECT first_name FROM hr.employees WHERE rownum = 1;");
    expect(out).not.toMatch(/ORA-/);
    bob.dispose();
  });

  it('SELECT ANY TABLE (via the DBA role) unlocks every schema', () => {
    const env = asSys('sel-any');
    run(env.sh, 'CREATE USER dba2 IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CREATE SESSION TO dba2;');
    run(env.sh, 'GRANT DBA TO dba2;');
    env.sh.dispose();

    const u = asUser(env.srv, 'dba2', 'Aa1234');
    const out = run(u, "SELECT COUNT(*) FROM hr.employees;");
    expect(out).not.toMatch(/ORA-/);
    u.dispose();
  });
});

describe('INSERT / UPDATE / DELETE enforcement', () => {
  it('without grant, INSERT/UPDATE/DELETE on someone else\'s table fail', () => {
    const env = asSys('dml-deny');
    run(env.sh, 'CREATE USER carol IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CONNECT TO carol;');
    run(env.sh, 'GRANT CREATE SESSION TO carol;');
    run(env.sh, 'CREATE TABLE hr.protected (id NUMBER);');
    env.sh.dispose();

    const carol = asUser(env.srv, 'carol', 'Aa1234');
    expect(run(carol, "INSERT INTO hr.protected VALUES (1);")).toMatch(/ORA-/);
    expect(run(carol, "UPDATE hr.protected SET id = 2;")).toMatch(/ORA-/);
    expect(run(carol, "DELETE FROM hr.protected;")).toMatch(/ORA-/);
    carol.dispose();
  });

  it('after GRANT INSERT, only INSERT works — UPDATE/DELETE still fail', () => {
    const env = asSys('dml-narrow');
    run(env.sh, 'CREATE USER dave IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CONNECT TO dave;');
    run(env.sh, 'GRANT CREATE SESSION TO dave;');
    run(env.sh, 'CREATE TABLE hr.narrow (id NUMBER);');
    run(env.sh, 'GRANT INSERT ON hr.narrow TO dave;');
    env.sh.dispose();

    const dave = asUser(env.srv, 'dave', 'Aa1234');
    expect(run(dave, 'INSERT INTO hr.narrow VALUES (1);')).not.toMatch(/ORA-/);
    expect(run(dave, 'UPDATE hr.narrow SET id = 2;')).toMatch(/ORA-/);
    expect(run(dave, 'DELETE FROM hr.narrow;')).toMatch(/ORA-/);
    dave.dispose();
  });
});

describe('Role-based inheritance', () => {
  it('user inherits SELECT via a custom role', () => {
    const env = asSys('role-inh');
    run(env.sh, 'CREATE ROLE app_reader;');
    run(env.sh, 'CREATE USER ed IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CREATE SESSION TO ed;');
    run(env.sh, 'GRANT app_reader TO ed;');
    run(env.sh, 'CREATE TABLE hr.shared (id NUMBER);');
    run(env.sh, 'GRANT SELECT ON hr.shared TO app_reader;');
    env.sh.dispose();

    const ed = asUser(env.srv, 'ed', 'Aa1234');
    expect(run(ed, 'SELECT COUNT(*) FROM hr.shared;')).not.toMatch(/ORA-/);
    ed.dispose();
  });

  it('REVOKE removes the inherited access', () => {
    const env = asSys('role-rev');
    run(env.sh, 'CREATE ROLE rr;');
    run(env.sh, 'CREATE USER fred IDENTIFIED BY "Aa1234";');
    run(env.sh, 'GRANT CREATE SESSION TO fred;');
    run(env.sh, 'GRANT rr TO fred;');
    run(env.sh, 'CREATE TABLE hr.gated (id NUMBER);');
    run(env.sh, 'GRANT SELECT ON hr.gated TO rr;');
    env.sh.dispose();

    let fred = asUser(env.srv, 'fred', 'Aa1234');
    expect(run(fred, 'SELECT COUNT(*) FROM hr.gated;')).not.toMatch(/ORA-/);
    fred.dispose();

    // Revoke the role grant; new sessions lose the inherited privilege.
    const env2 = asSys('role-rev2');
    // Reuse the same server — re-acquire SYS shell.
    // (the asSys above closed; re-create)
    const adm = SqlPlusSubShell.create(env.srv, ['/', 'as', 'sysdba']).subShell;
    run(adm, 'REVOKE SELECT ON hr.gated FROM rr;');
    adm.dispose();

    fred = asUser(env.srv, 'fred', 'Aa1234');
    expect(run(fred, 'SELECT COUNT(*) FROM hr.gated;')).toMatch(/ORA-00942/);
    fred.dispose();
    // unused — silence linter
    void env2;
  });
});

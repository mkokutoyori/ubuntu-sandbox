/**
 * Gaps in the access-management flows that the
 * oracle-access-management debug dump surfaced.
 *
 * Implemented as real catalog behaviour where the engine supports it,
 * and as parser tolerance (no-op + accept) where it doesn't yet.
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

function s(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
const run = (sh: ReturnType<typeof s>, q: string) => sh.processLine(q).output.join('\n');

describe('GRANT / REVOKE — multi-grantee list', () => {
  it('GRANT priv TO user1, user2, user3', () => {
    const sh = s('gml');
    for (const u of ['alice', 'bob', 'carol']) run(sh, `CREATE USER ${u} IDENTIFIED BY "Aa1234";`);
    expect(run(sh, 'GRANT CREATE SESSION TO alice, bob, carol;')).toMatch(/Grant succeeded/i);
    const rows = run(sh, "SELECT grantee FROM dba_sys_privs WHERE privilege='CREATE SESSION' AND grantee IN ('ALICE','BOB','CAROL');");
    for (const u of ['ALICE', 'BOB', 'CAROL']) expect(rows).toContain(u);
    sh.dispose();
  });

  it('REVOKE priv FROM user1, user2', () => {
    const sh = s('gml-r');
    run(sh, 'CREATE USER eve IDENTIFIED BY "Aa1234";');
    run(sh, 'CREATE USER frank IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CREATE TABLE TO eve, frank;');
    expect(run(sh, 'REVOKE CREATE TABLE FROM eve, frank;')).toMatch(/Revoke succeeded/i);
    sh.dispose();
  });
});

describe('CREATE ROLE — auth variants', () => {
  it('CREATE ROLE r IDENTIFIED BY "pwd"', () => {
    const sh = s('cr-pw');
    expect(run(sh, 'CREATE ROLE admin_role IDENTIFIED BY "Adm1n!";')).toMatch(/Role created/i);
    expect(run(sh, "SELECT password_required FROM dba_roles WHERE role='ADMIN_ROLE';"))
      .toContain('YES');
    sh.dispose();
  });

  it('CREATE ROLE r NOT IDENTIFIED', () => {
    const sh = s('cr-ni');
    expect(run(sh, 'CREATE ROLE reporting_role NOT IDENTIFIED;')).toMatch(/Role created/i);
    sh.dispose();
  });

  it('GRANT role TO user1, user2 (multi-grantee)', () => {
    const sh = s('cr-mg');
    run(sh, 'CREATE ROLE app_role;');
    run(sh, 'CREATE USER u1 IDENTIFIED BY "Aa1234";');
    run(sh, 'CREATE USER u2 IDENTIFIED BY "Aa1234";');
    expect(run(sh, 'GRANT app_role TO u1, u2;')).toMatch(/Grant succeeded/i);
    sh.dispose();
  });
});

describe('IDENTIFIED EXTERNALLY / GLOBALLY / VALUES', () => {
  it('CREATE USER … IDENTIFIED EXTERNALLY [AS \'…\']', () => {
    const sh = s('ide');
    expect(run(sh, "CREATE USER kerb_user IDENTIFIED EXTERNALLY AS 'kerberos@REALM.LOCAL';"))
      .toMatch(/User created/i);
    sh.dispose();
  });

  it('ALTER USER alice IDENTIFIED EXTERNALLY', () => {
    const sh = s('ide-a');
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    expect(run(sh, 'ALTER USER alice IDENTIFIED EXTERNALLY;')).toMatch(/User altered/i);
    sh.dispose();
  });

  it("ALTER USER … IDENTIFIED BY VALUES 'hash…' (hash login)", () => {
    const sh = s('idv');
    run(sh, 'CREATE USER frank IDENTIFIED BY "Aa1234";');
    expect(run(sh, "ALTER USER frank IDENTIFIED BY VALUES 'S:abcd1234...';"))
      .toMatch(/User altered/i);
    sh.dispose();
  });

  it("ALTER USER … IDENTIFIED BY new REPLACE old", () => {
    const sh = s('idr');
    run(sh, "CREATE USER iris IDENTIFIED BY \"IrisP\";");
    expect(run(sh, 'ALTER USER iris IDENTIFIED BY "NewIris1" REPLACE "IrisP";'))
      .toMatch(/User altered/i);
    sh.dispose();
  });
});

describe('ALTER USER … DEFAULT ROLE …', () => {
  it.each([
    'ALTER USER alice DEFAULT ROLE CONNECT;',
    'ALTER USER alice DEFAULT ROLE NONE;',
    'ALTER USER alice DEFAULT ROLE ALL EXCEPT CONNECT;',
    'ALTER USER alice DEFAULT ROLE CONNECT, RESOURCE;',
  ])('%s parses', (stmt) => {
    const sh = s(`dr-${stmt.replace(/[^a-z]/gi, '').slice(0, 12)}`);
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT CONNECT TO alice;');
    run(sh, 'GRANT RESOURCE TO alice;');
    expect(run(sh, stmt)).toMatch(/User altered/i);
    sh.dispose();
  });
});

describe('Column-level GRANT / REVOKE', () => {
  it("GRANT SELECT (col_list) ON tbl TO user", () => {
    const sh = s('clg');
    run(sh, 'CREATE USER dave IDENTIFIED BY "Aa1234";');
    expect(run(sh, 'GRANT SELECT (employee_id, first_name) ON hr.employees TO dave;'))
      .toMatch(/Grant succeeded/i);
    sh.dispose();
  });

  it("GRANT UPDATE (col) ON tbl TO user", () => {
    const sh = s('clu');
    run(sh, 'CREATE USER eve IDENTIFIED BY "Aa1234";');
    expect(run(sh, 'GRANT UPDATE (salary) ON hr.employees TO eve;'))
      .toMatch(/Grant succeeded/i);
    sh.dispose();
  });

  it("REVOKE UPDATE (col) ON tbl FROM user", () => {
    const sh = s('clr');
    run(sh, 'CREATE USER eve IDENTIFIED BY "Aa1234";');
    run(sh, 'GRANT UPDATE (salary) ON hr.employees TO eve;');
    expect(run(sh, 'REVOKE UPDATE (salary) ON hr.employees FROM eve;'))
      .toMatch(/Revoke succeeded/i);
    sh.dispose();
  });
});

describe('Unified Audit Policies', () => {
  it('CREATE / AUDIT / DROP AUDIT POLICY', () => {
    const sh = s('uap');
    expect(run(sh, 'CREATE AUDIT POLICY login_audit ACTIONS LOGON, LOGOFF;')).toMatch(/Audit policy created/i);
    expect(run(sh, 'CREATE AUDIT POLICY hr_audit ACTIONS UPDATE, DELETE ON hr.employees;')).toMatch(/Audit policy created/i);
    expect(run(sh, 'AUDIT POLICY hr_audit BY alice, bob;')).not.toMatch(/ORA-/);
    expect(run(sh, "SELECT policy_name FROM audit_unified_policies;")).toContain('LOGIN_AUDIT');
    expect(run(sh, 'DROP AUDIT POLICY hr_audit;')).toMatch(/Audit policy dropped/i);
    sh.dispose();
  });
});

describe('Proxy authentication (no-op tolerance)', () => {
  it.each([
    'ALTER USER alice GRANT CONNECT THROUGH bob;',
    'ALTER USER alice GRANT CONNECT THROUGH bob WITH ROLE app_role;',
    'ALTER USER alice REVOKE CONNECT THROUGH bob;',
  ])('%s parses', (stmt) => {
    const sh = s(`prx-${stmt.length}`);
    run(sh, 'CREATE USER alice IDENTIFIED BY "Aa1234";');
    run(sh, 'CREATE USER bob IDENTIFIED BY "Aa1234";');
    run(sh, 'CREATE ROLE app_role;');
    expect(run(sh, stmt)).toMatch(/User altered/i);
    sh.dispose();
  });

  it('PROXY_USERS view exists (empty by default)', () => {
    const sh = s('px');
    expect(run(sh, 'SELECT * FROM proxy_users;')).not.toMatch(/ORA-/);
    sh.dispose();
  });
});

describe('Missing views — empty truthful answers', () => {
  it.each([
    'V$ENCRYPTION_KEYS',
    'V$ENCRYPTION_WALLET',
    'DBA_ENCRYPTED_COLUMNS',
    'DBA_DV_REALM',
    'DBA_DV_ROLE',
    'DBA_DV_REALM_AUTH',
    'DBA_DV_COMMAND_RULE',
    'DBA_DV_FACTOR',
  ])('SELECT * FROM %s does not throw ORA-00942', (view) => {
    const sh = s(`v-${view}`);
    expect(run(sh, `SELECT * FROM ${view};`)).not.toMatch(/ORA-00942/);
    sh.dispose();
  });
});

describe('SYSDATE arithmetic', () => {
  it('SYSDATE - 1 is comparable to a DATE column', () => {
    const sh = s('sysd');
    const out = run(sh, "SELECT username FROM dba_users WHERE created > SYSDATE - 1;");
    expect(out).not.toMatch(/ORA-01722/);
    sh.dispose();
  });
});

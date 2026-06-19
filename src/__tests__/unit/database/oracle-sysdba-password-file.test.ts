/**
 * SYSDBA / SYSOPER authentication coherence — OS authentication for a
 * local bequeath connection vs. password-file authentication for a
 * remote Oracle Net connection.
 *
 * Before this suite, `sqlplus sys/<anything>@host as sysdba` connected
 * regardless of the password, and the AS-SYSDBA authorization for a
 * remote session leaned on the *client's* OS dba group instead of the
 * target's password file. The administrative privileges (SYSDBA/SYSOPER)
 * were also stored as ordinary system privileges, so they leaked into
 * DBA_SYS_PRIVS and SYS never appeared in V$PWFILE_USERS.
 *
 * Real Oracle:
 *   - `sqlplus / as sysdba`            → OS authentication (dba group);
 *   - `sqlplus sys/pw@host as sysdba`  → password-file authentication;
 *   - V$PWFILE_USERS lists SYS by default; granting SYSDBA adds a member;
 *   - DBA_SYS_PRIVS never contains SYSDBA/SYSOPER.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
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

/** A single Oracle server, booted local-SYSDBA, ready for queries. */
function localSysdba(): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', 'orcl', 0, 0);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

const run = (sh: SqlPlusSubShell, sql: string): string =>
  sh.processLine(sql).output.join('\n');

/** Two-host LAN: a client and a database host on 10.0.0.0/24. */
function lan() {
  const client = new LinuxServer('linux-server', 'dbclient', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.setHostname('dbclient');
  dbhost.setHostname('dbhost');
  // Boot the remote instance + listener so it accepts TNS connections.
  SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell.dispose();
  return { client, dbhost };
}

const ezSysdba = (host: string, user: string, pw: string) =>
  [`${user}/${pw}@//${host}/ORCL`, 'as', 'sysdba'];

describe('V$PWFILE_USERS reflects the password file', () => {
  it('lists SYS with SYSDBA and SYSOPER on a fresh instance', () => {
    const sh = localSysdba();
    const out = run(sh, "SELECT username, sysdba, sysoper FROM v$pwfile_users WHERE username = 'SYS';");
    expect(out).toMatch(/\bSYS\b/);
    expect(out).toMatch(/TRUE/);
  });

  it('SYSTEM is NOT a default password-file member', () => {
    const sh = localSysdba();
    const out = run(sh, "SELECT username FROM v$pwfile_users WHERE username = 'SYSTEM';");
    expect(out).not.toMatch(/\bSYSTEM\b/);
  });

  it('GRANT SYSDBA adds the user to V$PWFILE_USERS but NOT to DBA_SYS_PRIVS', () => {
    const sh = localSysdba();
    run(sh, 'CREATE USER bob IDENTIFIED BY "Welcome1#";');
    expect(run(sh, 'GRANT SYSDBA TO bob;')).toMatch(/Grant succeeded/i);

    const pwfile = run(sh, "SELECT username FROM v$pwfile_users WHERE username = 'BOB';");
    expect(pwfile).toMatch(/\bBOB\b/);

    const sysPrivs = run(sh, "SELECT privilege FROM dba_sys_privs WHERE grantee = 'BOB';");
    expect(sysPrivs).not.toMatch(/SYSDBA/);
  });

  it('REVOKE SYSDBA removes the user from the password file', () => {
    const sh = localSysdba();
    run(sh, 'CREATE USER carol IDENTIFIED BY "Welcome1#";');
    run(sh, 'GRANT SYSDBA TO carol;');
    expect(run(sh, 'REVOKE SYSDBA FROM carol;')).toMatch(/Revoke succeeded/i);
    const pwfile = run(sh, "SELECT username FROM v$pwfile_users WHERE username = 'CAROL';");
    expect(pwfile).not.toMatch(/\bCAROL\b/);
  });

  it('SYSDBA is never part of GRANT ALL PRIVILEGES', () => {
    const sh = localSysdba();
    run(sh, 'CREATE USER dave IDENTIFIED BY "Welcome1#";');
    run(sh, 'GRANT ALL PRIVILEGES TO dave;');
    const pwfile = run(sh, "SELECT username FROM v$pwfile_users WHERE username = 'DAVE';");
    expect(pwfile).not.toMatch(/\bDAVE\b/);
  });
});

describe('remote AS SYSDBA authenticates against the password file', () => {
  it('sys with the correct password connects', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ezSysdba('10.0.0.2', 'sys', 'oracle'));
    expect(r.loginOutput.join('\n')).toContain('Connected.');
    r.subShell.dispose();
  });

  it('sys with the wrong password is refused with ORA-01017', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ezSysdba('10.0.0.2', 'sys', 'wrongpw'));
    expect(r.loginOutput.join('\n')).toMatch(/ORA-01017/);
    r.subShell.dispose();
  });

  it('a user NOT in the password file cannot connect AS SYSDBA remotely', () => {
    const { client } = lan();
    // SCOTT exists with the right password but holds no SYSDBA privilege.
    const r = SqlPlusSubShell.create(client, ezSysdba('10.0.0.2', 'scott', 'tiger'));
    expect(r.loginOutput.join('\n')).toMatch(/ORA-01017/);
    r.subShell.dispose();
  });

  it('a user granted SYSDBA on the remote can connect AS SYSDBA over the network', () => {
    const { client, dbhost } = lan();
    const admin = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
    run(admin, 'CREATE USER appdba IDENTIFIED BY "Strong1#";');
    run(admin, 'GRANT SYSDBA TO appdba;');
    admin.dispose();

    const ok = SqlPlusSubShell.create(client, ezSysdba('10.0.0.2', 'appdba', 'Strong1#'));
    expect(ok.loginOutput.join('\n')).toContain('Connected.');
    ok.subShell.dispose();

    const bad = SqlPlusSubShell.create(client, ezSysdba('10.0.0.2', 'appdba', 'nope'));
    expect(bad.loginOutput.join('\n')).toMatch(/ORA-01017/);
    bad.subShell.dispose();
  });
});

describe('local bequeath AS SYSDBA is unaffected (OS authentication)', () => {
  it('connects without any password regardless of the password file', () => {
    const sh = localSysdba();
    // A bare `/ as sysdba` is an OS-authenticated bequeath connection;
    // the session lands on SYS and can run a privileged query.
    expect(run(sh, 'SHOW USER')).toMatch(/USER is "SYS"/i);
  });
});

describe('the LOGOFF audit record carries the session role', () => {
  it('a SYSDBA disconnect is audited as LOGOFF with SYSTEM_PRIVILEGE_USED = SYSDBA', () => {
    const srv = new LinuxServer('linux-server', 'orcl', 0, 0);
    // First SYSDBA session connects then disconnects (logoff trace).
    SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();

    // A fresh SYSDBA session inspects the persistent audit journal.
    const sh = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    const out = run(sh,
      "SELECT system_privilege_used FROM unified_audit_trail " +
      "WHERE action_name = 'LOGOFF' AND dbusername = 'SYS';");
    expect(out).toMatch(/SYSDBA/);
    expect(out).not.toMatch(/CREATE SESSION/);
  });
});

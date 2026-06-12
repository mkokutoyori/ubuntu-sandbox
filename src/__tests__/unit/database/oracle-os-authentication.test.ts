/**
 * OS authentication for bequeath connections (`sqlplus / as sysdba`).
 *
 * Real Oracle gates `AS SYSDBA` / `AS SYSOPER` on the operating-system
 * group of the calling process (the `dba` group set up by
 * oracle-database-preinstall), not on any database password. Before this
 * suite, the terminal layer never told the engine who the OS user was:
 * every `sqlplus / as sysdba` silently used a hardcoded privileged
 * context and always succeeded, regardless of the shell user.
 *
 * Covered here:
 *  - engine: connectAsSysdba/-Sysoper refuse a non-dba OS context with
 *    ORA-01031 and leave an audit-trail + alert-log trace (returncode
 *    1031, SESSIONID 0), like the real OS audit of refused SYS logons;
 *  - provisioning: initOracleFilesystem creates the oracle:oinstall+dba
 *    identity on the host (visible via `id`), as the preinstall RPM does;
 *  - terminal: the sub-shell snapshots the *real* shell user/groups, so
 *    `su` to an unprivileged account breaks `/ as sysdba` and dba-group
 *    membership restores it — and V$SESSION.OSUSER shows the real user.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { OsSecurityContext } from '@/database/oracle/security/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

const nonDbaCtx: OsSecurityContext = {
  osUser: 'eve', osGroup: 'eve', isDbaGroup: false,
  hostname: 'dbsrv', terminal: 'pts/1', program: 'sqlplus@dbsrv',
};
const dbaCtx: OsSecurityContext = {
  osUser: 'oracle', osGroup: 'oinstall', isDbaGroup: true,
  hostname: 'dbsrv', terminal: 'pts/0', program: 'sqlplus@dbsrv',
};

describe('engine — OS group gate on privileged connections', () => {
  let db: OracleDatabase;
  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
  });

  it('refuses SYSDBA for an OS user outside the dba group', () => {
    expect(() => db.connectAsSysdba(nonDbaCtx)).toThrow(/ORA-01031/);
  });

  it('refuses SYSOPER for an OS user outside the dba group', () => {
    expect(() => db.connectAsSysoper(nonDbaCtx)).toThrow(/ORA-01031/);
  });

  it('accepts SYSDBA for a dba-group member and records the real OS user', () => {
    const { sid } = db.connectAsSysdba(dbaCtx);
    expect(sid).toBeGreaterThan(0);
    const logon = db.catalog.getAuditTrail().find(
      e => e.actionName === 'LOGON' && e.sessionId === sid);
    expect(logon?.osUsername).toBe('oracle');
    expect(logon?.userhost).toBe('dbsrv');
  });

  it('a refused SYSDBA attempt is auditable (returncode 1031, SESSIONID 0)', () => {
    expect(() => db.connectAsSysdba(nonDbaCtx)).toThrow();
    const failed = db.catalog.getAuditTrail().find(
      e => e.actionName === 'LOGON' && e.returncode === 1031);
    expect(failed).toBeDefined();
    expect(failed?.sessionId).toBe(0);
    expect(failed?.osUsername).toBe('eve');
    expect(db.instance.getAlertLog().some(l => /Failed SYSDBA logon.*eve/.test(l))).toBe(true);
  });
});

describe('terminal — bequeath authentication follows the real shell user', () => {
  function makeServer(name: string): LinuxServer {
    return new LinuxServer('linux-server', name, 0, 0);
  }

  it('provisions the oracle software owner (oracle:oinstall, member of dba)', () => {
    const srv = makeServer('dbsrv1');
    const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    const id = srv.executeShellCommandSync('id oracle');
    expect(id).toMatch(/uid=54321\(oracle\)/);
    expect(id).toMatch(/oinstall/);
    expect(id).toMatch(/dba/);
    subShell.dispose();
  });

  it('root (provisioned as DBA staff) connects with / as sysdba', () => {
    const srv = makeServer('dbsrv2');
    const { subShell, loginOutput } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    expect(loginOutput.join('\n')).toContain('Connected.');
    subShell.dispose();
  });

  it('an unprivileged user gets ORA-01031, dba membership restores access', async () => {
    const srv = makeServer('dbsrv3');
    // First sqlplus run installs the Oracle FS + OS identity.
    SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();

    srv.executeShellCommandSync('useradd -m eve');
    await srv.executeCommand('su - eve');
    expect(srv.getCurrentUser()).toBe('eve');

    const refused = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    expect(refused.loginOutput.join('\n')).toMatch(/ORA-01031/);
    refused.subShell.dispose();

    // Back to root, enrol eve in dba, retry as eve: bequeath now works.
    srv.handleExit();
    expect(srv.getCurrentUser()).toBe('root');
    srv.executeShellCommandSync('usermod -aG dba eve');
    await srv.executeCommand('su - eve');

    const granted = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    expect(granted.loginOutput.join('\n')).toContain('Connected.');

    // The session carries the real OS identity into V$SESSION.
    const osusers = granted.subShell
      .processLine("SELECT osuser FROM v$session;").output.join('\n');
    expect(osusers).toContain('eve');
    granted.subShell.dispose();
  });

  it('password logins also audit the real OS user', () => {
    const srv = makeServer('dbsrv4');
    const boot = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
    boot.subShell.processLine('CREATE USER appuser IDENTIFIED BY secret;');
    boot.subShell.processLine('GRANT CREATE SESSION TO appuser;');
    boot.subShell.dispose();

    const app = SqlPlusSubShell.create(srv, ['appuser/secret']);
    expect(app.loginOutput.join('\n')).toContain('Connected.');
    app.subShell.dispose();

    const audit = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell
      .processLine("SELECT os_username, username FROM dba_audit_trail WHERE action_name = 'LOGON' AND username = 'APPUSER';");
    // Engine-level default would have been 'oracle'; the shell user is root.
    expect(audit.output.join('\n')).toMatch(/root/i);
  });
});

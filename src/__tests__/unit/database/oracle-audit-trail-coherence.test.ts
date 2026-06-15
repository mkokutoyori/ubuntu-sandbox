/**
 * audit_trail coherence — `.aud` files appear exactly when real Oracle
 * writes them.
 *
 * Before: every audited action and every connection wrote an adump/.aud
 * file, even though the seeded parameter is audit_trail=DB — under which
 * regular records live in the database trail (DBA_AUDIT_TRAIL) only. A
 * DBA reading `SHOW PARAMETER audit_trail` (=DB) would not expect any OS
 * audit files for ordinary user activity.
 *
 * Now the sync honours the live parameter:
 *  - audit_trail=DB → only mandatory auditing reaches the OS trail:
 *    SYS operations (audit_sys_operations), privileged (SYSDBA/SYSOPER)
 *    logons, and every FAILED logon. A successful NORMAL logon/action
 *    does NOT write a .aud.
 *  - audit_trail=OS → ordinary NORMAL activity writes .aud too.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function boot(name: string): LinuxServer {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
  return srv;
}

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

/** Concatenated content of every .aud file under adump/. */
function audDump(srv: LinuxServer): string {
  const ls = sh(srv, `ls ${ORACLE_CONFIG.AUDIT_DIR}`);
  const names = ls.split(/\s+/).filter(n => n.endsWith('.aud'));
  return names.map(n => sh(srv, `cat ${ORACLE_CONFIG.AUDIT_DIR}/${n}`)).join('\n----\n');
}

function makeNormalUser(srv: LinuxServer, user: string, pw: string): void {
  const sys = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
  sys.processLine(`CREATE USER ${user} IDENTIFIED BY ${pw};`);
  sys.processLine(`GRANT CREATE SESSION, CREATE TABLE TO ${user};`);
  sys.processLine(`ALTER USER ${user} QUOTA UNLIMITED ON USERS;`);
  sys.dispose();
}

describe('audit_trail=DB keeps ordinary activity out of adump/', () => {
  it('a successful NORMAL logon writes no .aud naming that user', () => {
    const srv = boot('at-db-1');
    makeNormalUser(srv, 'APPUSER', 'pw');
    const u = SqlPlusSubShell.create(srv, ['APPUSER/pw']).subShell;
    u.dispose();
    // SYSDBA boot/installer logons DO leave mandatory .aud files, so the
    // directory is not empty — but none of them is APPUSER's logon.
    expect(audDump(srv)).not.toMatch(/DATABASE USER:\s*APPUSER/);
  });

  it('SYS operations still write .aud (audit_sys_operations is on)', () => {
    const srv = boot('at-db-2');
    const sys = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
    sys.processLine("CREATE TABLESPACE sys_marks DATAFILE '/u01/oradata/ORCL/sm.dbf' SIZE 10M;");
    sys.dispose();
    expect(audDump(srv)).toMatch(/CREATE TABLESPACE/i);
  });

  it('a FAILED logon is mandatorily audited to the OS trail', () => {
    const srv = boot('at-db-3');
    makeNormalUser(srv, 'WHO', 'right');
    const bad = SqlPlusSubShell.create(srv, ['WHO/wrong']).subShell;
    bad.dispose();
    const dump = audDump(srv);
    // The failed attempt for WHO is recorded (STATUS 1017), even under DB.
    expect(dump).toMatch(/DATABASE USER:\s*WHO/);
    expect(dump).toMatch(/STATUS:\s*1017/);
  });
});

describe('audit_trail=OS sends ordinary activity to adump/', () => {
  it('a NORMAL logon writes a .aud once audit_trail flips to OS', () => {
    const srv = boot('at-os-1');
    const db = getRegisteredOracleDatabase(srv.getId())!;
    db.instance.setParameter('audit_trail', 'OS');
    makeNormalUser(srv, 'OSUSER', 'pw');
    const u = SqlPlusSubShell.create(srv, ['OSUSER/pw']).subShell;
    u.dispose();
    expect(audDump(srv)).toMatch(/DATABASE USER:\s*OSUSER/);
  });
});

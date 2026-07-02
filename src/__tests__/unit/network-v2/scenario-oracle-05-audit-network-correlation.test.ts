/**
 * Scenario 5 — Oracle audit of sensitive-data access, correlated with
 * the listener connection log across the LAN.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function lan() {
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const legit = new LinuxServer('linux-server', 'reportingclient', 0, 0);
  const rogue = new LinuxServer('linux-server', 'intruderbox', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(dbhost.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(legit.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(rogue.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  legit.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  rogue.getPorts()[0].configureIP(new IPAddress('10.0.0.66'), mask);
  dbhost.setHostname('dbhost');
  legit.setHostname('reportingclient');
  rogue.setHostname('intruderbox');
  return { dbhost, legit, rogue };
}

function admin(dbhost: LinuxServer) {
  return SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
}

function setupSensitiveTable(dbhost: LinuxServer) {
  const a = admin(dbhost);
  a.subShell.processLine('CREATE USER finance IDENTIFIED BY finpass;');
  a.subShell.processLine('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO finance;');
  const owner = SqlPlusSubShell.create(dbhost, ['finance/finpass']);
  owner.subShell.processLine('CREATE TABLE finance.accounts (customer VARCHAR2(30), balance NUMBER);');
  owner.subShell.processLine("INSERT INTO finance.accounts VALUES ('ALICE', 1000);");
  owner.subShell.processLine('COMMIT;');
  owner.subShell.dispose();

  a.subShell.processLine('CREATE USER analyst IDENTIFIED BY anpass;');
  a.subShell.processLine('GRANT CREATE SESSION TO analyst;');
  a.subShell.processLine('GRANT SELECT ON finance.accounts TO analyst;');

  a.subShell.processLine('AUDIT SELECT ON finance.accounts BY ACCESS;');
  a.subShell.dispose();
}

describe('AUDIT SELECT ON finance.accounts BY ACCESS produces a real, per-access trail', () => {
  it('a legitimate SELECT from the analyst machine is recorded with the real client host', () => {
    const { dbhost, legit } = lan();
    setupSensitiveTable(dbhost);

    const session = SqlPlusSubShell.create(legit, ['analyst/anpass@//10.0.0.2/ORCL']);
    session.subShell.processLine('SELECT customer FROM finance.accounts;');

    const admin2 = admin(dbhost);
    const trail = admin2.subShell.processLine(
      "SELECT username, userhost, action_name, sql_text, returncode FROM dba_audit_trail "
      + "WHERE action_name = 'SELECT' AND obj_name = 'ACCOUNTS';"
    ).output.join('\n');
    expect(trail).toContain('ANALYST');
    expect(trail).toContain('reportingclient');
    expect(trail).toMatch(/SELECT customer FROM finance\.accounts/i);

    admin2.subShell.dispose();
    session.subShell.dispose();
  });

  it('an unauthorized SELECT attempt from another machine is still recorded, with a non-zero return code', () => {
    const { dbhost, rogue } = lan();
    setupSensitiveTable(dbhost);

    const a = admin(dbhost);
    a.subShell.processLine('CREATE USER outsider IDENTIFIED BY outpass;');
    a.subShell.processLine('GRANT CREATE SESSION TO outsider;');
    a.subShell.dispose();

    const session = SqlPlusSubShell.create(rogue, ['outsider/outpass@//10.0.0.2/ORCL']);
    const attempt = session.subShell.processLine('SELECT customer FROM finance.accounts;').output.join('\n');
    expect(attempt).toMatch(/ORA-00942/);

    const admin2 = admin(dbhost);
    const trail = admin2.subShell.processLine(
      "SELECT username, userhost, returncode FROM dba_audit_trail "
      + "WHERE action_name = 'SELECT' AND username = 'OUTSIDER';"
    ).output.join('\n');
    expect(trail).toContain('OUTSIDER');
    expect(trail).toContain('intruderbox');
    expect(trail).not.toMatch(/\s0\s*$/m);

    admin2.subShell.dispose();
    session.subShell.dispose();
  });

  it('the listener log source IP and the audit trail USERHOST correlate to the same client for the same access', () => {
    const { dbhost, legit } = lan();
    setupSensitiveTable(dbhost);

    const session = SqlPlusSubShell.create(legit, ['analyst/anpass@//10.0.0.2/ORCL']);
    session.subShell.processLine('SELECT customer FROM finance.accounts;');

    const db = getOracleDatabase(dbhost.getId());
    const listenerEntry = db.instance.getListenerLog().find(e => e.service === 'ORCL' && e.result === 'established');
    expect(listenerEntry).toBeDefined();
    expect(listenerEntry!.sourceIp).toBe('10.0.0.10');
    expect(legit.getHostname()).toBe('reportingclient');

    const a = admin(dbhost);
    const trail = a.subShell.processLine(
      "SELECT userhost FROM dba_audit_trail WHERE action_name = 'SELECT' AND obj_name = 'ACCOUNTS';"
    ).output.join('\n');
    expect(trail).toContain(legit.getHostname());

    a.subShell.dispose();
    session.subShell.dispose();
  });

  it('the successful session is still visible in v$session at the moment of access', () => {
    const { dbhost, legit } = lan();
    setupSensitiveTable(dbhost);

    const session = SqlPlusSubShell.create(legit, ['analyst/anpass@//10.0.0.2/ORCL']);
    session.subShell.processLine('SELECT customer FROM finance.accounts;');

    const a = admin(dbhost);
    const rows = a.subShell.processLine(
      "SELECT username, machine, status FROM v$session WHERE username = 'ANALYST';"
    ).output.join('\n');
    expect(rows).toContain('ANALYST');
    expect(rows).toContain('reportingclient');
    expect(rows).toMatch(/ACTIVE|INACTIVE/);

    a.subShell.dispose();
    session.subShell.dispose();
  });

  it('no session escapes the trail: even the local DBA connection is audited', () => {
    const { dbhost } = lan();
    setupSensitiveTable(dbhost);

    const a = admin(dbhost);
    const trail = a.subShell.processLine(
      "SELECT username, action_name FROM dba_audit_trail WHERE action_name = 'LOGON';"
    ).output.join('\n');
    expect(trail).toContain('SYS');
    a.subShell.dispose();
  });
});

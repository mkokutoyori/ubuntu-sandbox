/**
 * Scenario 2 — differentiated diagnosis of the four classic Oracle
 * connect failures: unknown alias, listener down, unregistered service,
 * bad password. Each must produce a distinct ORA- code, and the network
 * capture / listener.log must distinguish network-level failures (no
 * TCP reachability at all) from application-level ones (TCP reachable,
 * Oracle itself refuses).
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
import { handleLsnrctl } from '@/terminal/commands/OracleCommands';

const TNSNAMES_PATH = '/u01/app/oracle/product/19c/dbhome_1/network/admin/tnsnames.ora';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function lan() {
  const client = new LinuxServer('linux-server', 'appclient', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.setHostname('appclient');
  dbhost.setHostname('dbhost');

  SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell.dispose();

  const existing = client.readFileForEditor(TNSNAMES_PATH) ?? '';
  client.writeFileFromEditor(TNSNAMES_PATH, existing + `
ORCLDB =
  (DESCRIPTION =
    (ADDRESS = (PROTOCOL = TCP)(HOST = 10.0.0.2)(PORT = 1521))
    (CONNECT_DATA = (SERVICE_NAME = ORCL))
  )
`);
  return { client, dbhost };
}

function probe(client: LinuxServer, ip: string, port: number): boolean {
  const host = client as unknown as { tcpProbeSync(target: { toString(): string }, port: number): boolean };
  return host.tcpProbeSync({ toString: () => ip }, port);
}

describe('Case 1 — unknown alias: ORA-12154, purely client-side, no network traffic', () => {
  it('never reaches the listener: no entry in listener.log, TCP reachability unaffected', () => {
    const { client, dbhost } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@GHOSTDB']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-12154/);
    r.subShell.dispose();

    const db = getOracleDatabase(dbhost.getId());
    expect(db.instance.getListenerLog().length).toBe(0);
    expect(probe(client, '10.0.0.2', 1521)).toBe(true);
  });
});

describe('Case 2 — listener stopped: ORA-12541, a real network-level failure', () => {
  it('the port itself becomes unreachable, and nothing is logged (no listener process to log)', () => {
    const { client, dbhost } = lan();
    handleLsnrctl(dbhost, ['stop'], () => {});

    expect(probe(client, '10.0.0.2', 1521)).toBe(false);

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-12541/);
    r.subShell.dispose();

    const db = getOracleDatabase(dbhost.getId());
    expect(db.instance.getListenerLog().length).toBe(0);
    expect(dbhost.executeShellCommandSync('netstat -tlnp')).not.toMatch(/:1521\b/);
  });
});

describe('Case 3 — service not registered: ORA-12514, an application-level refusal', () => {
  it('TCP is reachable, the listener accepts the SYN, but refuses the service and logs it', () => {
    const { client, dbhost } = lan();

    expect(probe(client, '10.0.0.2', 1521)).toBe(true);

    const r = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/NOPE']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-12514/);
    r.subShell.dispose();

    const db = getOracleDatabase(dbhost.getId());
    const log = db.instance.getListenerLog();
    const entry = log[log.length - 1];
    expect(entry.service).toBe('NOPE');
    expect(entry.result).toBe('refused');
    expect(entry.returnCode).toBe(12514);

    expect(dbhost.executeShellCommandSync('netstat -tlnp')).toMatch(/:1521\b.*tnslsnr/);
  });
});

describe('Case 4 — correct listener and service, wrong password: ORA-01017, purely an auth failure', () => {
  it('the listener establishes the connection normally; only the RDBMS rejects the credentials', () => {
    const { client, dbhost } = lan();

    expect(probe(client, '10.0.0.2', 1521)).toBe(true);

    const r = SqlPlusSubShell.create(client, ['system/wrongpassword@ORCLDB']);
    expect(r.loginOutput.join('\n')).toMatch(/ORA-01017/);
    r.subShell.dispose();

    const db = getOracleDatabase(dbhost.getId());
    const log = db.instance.getListenerLog();
    const entry = log[log.length - 1];
    expect(entry.service).toBe('ORCL');
    expect(entry.result).toBe('established');
    expect(entry.returnCode).toBe(0);
  });
});

describe('the four cases are diagnosable in isolation from the client message alone', () => {
  it('each ORA- code maps to exactly one of the four scenarios', () => {
    const { client, dbhost } = lan();

    const alias = SqlPlusSubShell.create(client, ['system/oracle@GHOSTDB']);
    const aliasMsg = alias.loginOutput.join('\n');
    alias.subShell.dispose();

    handleLsnrctl(dbhost, ['stop'], () => {});
    const down = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    const downMsg = down.loginOutput.join('\n');
    down.subShell.dispose();
    handleLsnrctl(dbhost, ['start'], () => {});

    const service = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/NOPE']);
    const serviceMsg = service.loginOutput.join('\n');
    service.subShell.dispose();

    const auth = SqlPlusSubShell.create(client, ['system/wrongpassword@ORCLDB']);
    const authMsg = auth.loginOutput.join('\n');
    auth.subShell.dispose();

    expect(aliasMsg).toMatch(/ORA-12154/);
    expect(downMsg).toMatch(/ORA-12541/);
    expect(serviceMsg).toMatch(/ORA-12514/);
    expect(authMsg).toMatch(/ORA-01017/);

    const codes = [aliasMsg, downMsg, serviceMsg, authMsg].map(m => m.match(/ORA-\d{5}/)?.[0]);
    expect(new Set(codes).size).toBe(4);
  });
});

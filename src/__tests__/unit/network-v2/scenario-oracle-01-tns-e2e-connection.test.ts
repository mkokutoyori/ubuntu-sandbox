/**
 * Scenario 1 — TNS resolution and end-to-end SQL*Net connection.
 *
 * A client machine on one host reaches an Oracle instance on another host
 * through a tnsnames.ora alias, the real listener on port 1521, and the
 * session lands in V$SESSION with the client's true identity.
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

const lsnrctl = (srv: LinuxServer, sub: string): string => {
  const lines: string[] = [];
  handleLsnrctl(srv, [sub], (t) => lines.push(t));
  return lines.join('\n');
};

describe('tnsnames.ora on the client carries the real connect descriptor', () => {
  it('the alias resolves to the configured host, port and service name', () => {
    const { client } = lan();
    const content = client.readFileForEditor(TNSNAMES_PATH)!;
    expect(content).toMatch(/ORCLDB\s*=/);
    expect(content).toMatch(/HOST\s*=\s*10\.0\.0\.2/);
    expect(content).toMatch(/PORT\s*=\s*1521/);
    expect(content).toMatch(/SERVICE_NAME\s*=\s*ORCL/);
  });
});

describe('the listener on the DB host really listens and advertises the service', () => {
  it('lsnrctl status lists the ORCL service bound to port 1521', () => {
    const { dbhost } = lan();
    const status = lsnrctl(dbhost, 'status');
    expect(status).toMatch(/PORT=1521/);
    expect(status).toMatch(/Service "ORCL" has 1 instance/);
    expect(status).toMatch(/status READY/);
  });

  it('netstat/ss on the DB host show a real tnslsnr socket bound to 1521', () => {
    const { dbhost } = lan();
    expect(dbhost.executeShellCommandSync('netstat -tlnp')).toMatch(/:1521\b.*tnslsnr/);
    expect(dbhost.executeShellCommandSync('ss -tlnp')).toMatch(/1521/);
  });
});

describe('the network genuinely carries the connection attempt to port 1521', () => {
  it('a TCP probe from the client to the DB host succeeds only on 1521', () => {
    const { client, dbhost } = lan();
    const host = client as unknown as { tcpProbeSync(target: { toString(): string }, port: number): boolean };
    const target = { toString: () => '10.0.0.2' };
    expect(host.tcpProbeSync(target, 1521)).toBe(true);
    expect(host.tcpProbeSync(target, 1522)).toBe(false);
    void dbhost;
  });

  it('stopping the listener makes the same port immediately unreachable', () => {
    const { client, dbhost } = lan();
    handleLsnrctl(dbhost, ['stop'], () => {});
    const host = client as unknown as { tcpProbeSync(target: { toString(): string }, port: number): boolean };
    expect(host.tcpProbeSync({ toString: () => '10.0.0.2' }, 1521)).toBe(false);
  });
});

describe('the SQL*Plus session establishes end to end over the alias', () => {
  it('sqlplus system/oracle@ORCLDB connects and the login banner confirms it', () => {
    const { client } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    expect(r.loginOutput.join('\n')).toContain('Connected.');
    r.subShell.dispose();
  });

  it('a query on the remote instance actually runs there, not locally', () => {
    const { client, dbhost } = lan();
    const remoteSetup = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
    remoteSetup.subShell.processLine('CREATE TABLE system.probe (city VARCHAR2(20));');
    remoteSetup.subShell.processLine("INSERT INTO system.probe VALUES ('YAOUNDE');");
    remoteSetup.subShell.processLine('COMMIT;');
    remoteSetup.subShell.dispose();

    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    const rows = r.subShell.processLine('SELECT city FROM system.probe;');
    expect(rows.output.join('\n')).toContain('YAOUNDE');
    r.subShell.dispose();
  });
});

describe('listener.log records the connection with the real client IP and outcome', () => {
  it('a successful connection logs source IP, service and an "established" result', () => {
    const { client, dbhost } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);
    r.subShell.dispose();

    const db = getOracleDatabase(dbhost.getId());
    const log = db.instance.getListenerLog();
    const entry = log[log.length - 1];
    expect(entry.sourceIp).toBe('10.0.0.1');
    expect(entry.service).toBe('ORCL');
    expect(entry.result).toBe('established');

    const file = dbhost.readFileForEditor(
      '/u01/app/oracle/diag/tnslsnr/orcl/listener/trace/listener.log');
    expect(file).toContain('10.0.0.1');
    expect(file).toContain('SERVICE_NAME=ORCL');
    expect(file).toContain('established');
  });
});

describe('V$SESSION on the DB host reflects the connected client', () => {
  it('shows the client username, machine, program and an active status', () => {
    const { client, dbhost } = lan();
    const r = SqlPlusSubShell.create(client, ['system/oracle@ORCLDB']);

    const admin = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']);
    const rows = admin.subShell.processLine(
      "SELECT username, machine, program, status FROM v$session WHERE username = 'SYSTEM';"
    ).output.join('\n');
    expect(rows).toContain('SYSTEM');
    expect(rows).toContain('appclient');
    expect(rows).toMatch(/sqlplus@appclient/);
    expect(rows).toMatch(/ACTIVE|INACTIVE/);

    admin.subShell.dispose();
    r.subShell.dispose();
  });
});

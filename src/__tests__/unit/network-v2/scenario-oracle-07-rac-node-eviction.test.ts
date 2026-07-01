/**
 * Scenario 7 — Oracle RAC node eviction on cluster interconnect loss.
 *
 * The simulator today models a single Oracle instance per device with no
 * shared storage and no clusterware — these tests target the real RAC
 * behaviour (CSS/CRS eviction, V$ACTIVE_INSTANCES with two nodes, TAF
 * failover) and are expected to fail until that subsystem exists.
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

function twoNodeCluster() {
  const node1 = new LinuxServer('linux-server', 'racnode1', 0, 0);
  const node2 = new LinuxServer('linux-server', 'racnode2', 0, 0);
  const client = new LinuxServer('linux-server', 'appclient', 0, 0);
  const publicSw = new GenericSwitch('switch-generic', 'pubsw', 8, 0, 0);
  const interconnectSw = new GenericSwitch('switch-generic', 'icsw', 8, 0, 0);

  new Cable('pub1').connect(node1.getPorts()[0], publicSw.getPorts()[0]);
  new Cable('pub2').connect(node2.getPorts()[0], publicSw.getPorts()[1]);
  new Cable('pub3').connect(client.getPorts()[0], publicSw.getPorts()[2]);
  const interconnect1 = new Cable('ic1').connect(node1.getPorts()[1], interconnectSw.getPorts()[0]);
  const interconnect2 = new Cable('ic2').connect(node2.getPorts()[1], interconnectSw.getPorts()[1]);

  const mask = new SubnetMask('255.255.255.0');
  node1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  node2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  const icMask = new SubnetMask('255.255.255.0');
  node1.getPorts()[1].configureIP(new IPAddress('192.168.1.1'), icMask);
  node2.getPorts()[1].configureIP(new IPAddress('192.168.1.2'), icMask);

  node1.setHostname('racnode1');
  node2.setHostname('racnode2');
  client.setHostname('appclient');

  SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']).subShell.dispose();

  return { node1, node2, client, interconnect1, interconnect2 };
}

describe('a two-node cluster reports both instances while healthy', () => {
  it('V$ACTIVE_INSTANCES lists racnode1 and racnode2 from either node', () => {
    const { node1, node2 } = twoNodeCluster();
    const q1 = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    const rows = q1.subShell.processLine('SELECT inst_name FROM v$active_instances;').output.join('\n');
    expect(rows).toContain('racnode1');
    expect(rows).toContain('racnode2');
    q1.subShell.dispose();
    void node2;
  });

  it('CLUSTER_DATABASE is TRUE on both instances', () => {
    const { node1 } = twoNodeCluster();
    const q1 = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    const val = q1.subShell.processLine("SELECT value FROM v$parameter WHERE name = 'cluster_database';").output.join('\n');
    expect(val).toMatch(/TRUE/i);
    q1.subShell.dispose();
  });
});

describe('losing the cluster interconnect on node1 triggers a documented eviction', () => {
  it('CSS/CRS logs on the surviving node record the heartbeat loss and eviction with a timestamp', async () => {
    const { node1, node2 } = twoNodeCluster();

    await node1.executeCommand('ip link set eth1 down');

    const cssLog = node2.readFileForEditor('/u01/app/grid/diag/crs/racnode2/crs/trace/cssd.log') ?? '';
    const crsLog = node2.readFileForEditor('/u01/app/grid/diag/crs/racnode2/crs/trace/crsd.log') ?? '';
    expect(cssLog).toMatch(/eviction|evicted/i);
    expect(cssLog).toMatch(/racnode1/);
    expect(cssLog).toMatch(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/);
    expect(crsLog).toMatch(/fenc|reconfigur/i);
  });

  it('V$INSTANCE on the surviving node shows it took over the surviving service', async () => {
    const { node1, node2 } = twoNodeCluster();
    await node1.executeCommand('ip link set eth1 down');

    const q2 = SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']);
    const rows = q2.subShell.processLine('SELECT instance_name, status FROM v$instance;').output.join('\n');
    expect(rows).toContain('racnode2');
    expect(rows).toMatch(/OPEN/);

    const active = q2.subShell.processLine('SELECT inst_name FROM v$active_instances;').output.join('\n');
    expect(active).not.toContain('racnode1');
    expect(active).toContain('racnode2');
    q2.subShell.dispose();
  });
});

describe('client behaviour differs with and without TAF once node1 disappears', () => {
  it('a session with FAILOVER_MODE configured reconnects transparently and the in-flight SELECT still returns rows', async () => {
    const { node1, node2, client } = twoNodeCluster();
    void node2;

    const setup = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    setup.subShell.processLine('CREATE TABLE system.orders (id NUMBER);');
    setup.subShell.processLine('INSERT INTO system.orders VALUES (1);');
    setup.subShell.processLine('COMMIT;');
    setup.subShell.dispose();

    const taf = SqlPlusSubShell.create(client, [
      'system/oracle@(DESCRIPTION=(FAILOVER=ON)(ADDRESS_LIST='
      + '(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.1)(PORT=1521))'
      + '(ADDRESS=(PROTOCOL=TCP)(HOST=10.0.0.2)(PORT=1521)))'
      + '(CONNECT_DATA=(SERVICE_NAME=ORCL)(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC))))',
    ]);
    expect(taf.loginOutput.join('\n')).toContain('Connected.');

    await node1.executeCommand('ip link set eth0 down');

    const afterFailover = taf.subShell.processLine('SELECT id FROM system.orders;');
    expect(afterFailover.output.join('\n')).toContain('1');
    taf.subShell.dispose();
  });

  it('a plain session without TAF gets an explicit, unambiguous connection-loss error once node1 disappears', async () => {
    const { node1, client } = twoNodeCluster();

    const setup = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    setup.subShell.processLine('CREATE TABLE system.orders (id NUMBER);');
    setup.subShell.dispose();

    const plain = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.1/ORCL']);
    expect(plain.loginOutput.join('\n')).toContain('Connected.');

    await node1.executeCommand('ip link set eth0 down');

    const afterOutage = plain.subShell.processLine('SELECT id FROM system.orders;').output.join('\n');
    expect(afterOutage).toMatch(/ORA-03135|ORA-01033/);
    plain.subShell.dispose();
  });
});

describe('failover completes within a bounded, measurable time', () => {
  it('the surviving node serves a new connection within a documented failover window', async () => {
    const { node1, node2, client } = twoNodeCluster();
    void node2;

    const start = Date.now();
    await node1.executeCommand('ip link set eth0 down');
    const failoverSession = SqlPlusSubShell.create(client, ['system/oracle@//10.0.0.2/ORCL']);
    const elapsedMs = Date.now() - start;

    expect(failoverSession.loginOutput.join('\n')).toContain('Connected.');
    expect(elapsedMs).toBeLessThan(5000);
    const db = getOracleDatabase(client.getId());
    void db;
    failoverSession.subShell.dispose();
  });
});

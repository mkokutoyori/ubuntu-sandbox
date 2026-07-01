/**
 * Scenario 8 — RAC cluster interconnect and Cache Fusion coherence.
 *
 * No shared storage, no Cache Fusion block transfer, and no interconnect
 * impairment mechanism exist today — these tests target the real RAC
 * behaviour and are expected to fail until that subsystem exists.
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

function twoNodeClusterWithInterconnect() {
  const node1 = new LinuxServer('linux-server', 'racnode1', 0, 0);
  const node2 = new LinuxServer('linux-server', 'racnode2', 0, 0);
  const publicSw = new GenericSwitch('switch-generic', 'pubsw', 8, 0, 0);
  const interconnectSw = new GenericSwitch('switch-generic', 'icsw', 8, 0, 0);

  new Cable('pub1').connect(node1.getPorts()[0], publicSw.getPorts()[0]);
  new Cable('pub2').connect(node2.getPorts()[0], publicSw.getPorts()[1]);
  new Cable('ic1').connect(node1.getPorts()[1], interconnectSw.getPorts()[0]);
  new Cable('ic2').connect(node2.getPorts()[1], interconnectSw.getPorts()[1]);

  const mask = new SubnetMask('255.255.255.0');
  node1.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  node2.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  node1.getPorts()[1].configureIP(new IPAddress('192.168.1.1'), mask);
  node2.getPorts()[1].configureIP(new IPAddress('192.168.1.2'), mask);
  node1.setHostname('racnode1');
  node2.setHostname('racnode2');

  SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']).subShell.dispose();

  return { node1, node2 };
}

describe('two RAC instances contend on the same blocks and generate Cache Fusion traffic', () => {
  it('a table created on node1 is visible and updatable from node2 through shared storage', () => {
    const { node1, node2 } = twoNodeClusterWithInterconnect();

    const s1 = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    s1.subShell.processLine('CREATE TABLE system.shared_counter (n NUMBER);');
    s1.subShell.processLine('INSERT INTO system.shared_counter VALUES (0);');
    s1.subShell.processLine('COMMIT;');
    s1.subShell.dispose();

    const s2 = SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']);
    const rows = s2.subShell.processLine('SELECT n FROM system.shared_counter;').output.join('\n');
    expect(rows).not.toMatch(/ORA-00942/);
    expect(rows).toContain('0');
    s2.subShell.dispose();
  });

  it('gc cr blocks received / gc current blocks received increase after cross-node access to the same block', () => {
    const { node1, node2 } = twoNodeClusterWithInterconnect();
    const s1 = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    s1.subShell.processLine('CREATE TABLE system.shared_counter (n NUMBER);');
    s1.subShell.processLine('INSERT INTO system.shared_counter VALUES (0);');
    s1.subShell.processLine('COMMIT;');

    const before = s1.subShell.processLine(
      "SELECT value FROM v$sysstat WHERE name = 'gc cr blocks received';"
    ).output.join('\n');

    const s2 = SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']);
    s2.subShell.processLine('UPDATE system.shared_counter SET n = n + 1;');
    s2.subShell.processLine('COMMIT;');
    s2.subShell.dispose();

    const after = s1.subShell.processLine(
      "SELECT value FROM v$sysstat WHERE name = 'gc cr blocks received';"
    ).output.join('\n');
    expect(Number(after.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(Number(before.match(/\d+/)?.[0] ?? 0));
    s1.subShell.dispose();
  });
});

describe('degrading the private interconnect measurably degrades Cache Fusion response times', () => {
  it('adding latency/loss on the interconnect link is reflected by real ping RTT on that link', async () => {
    const { node1, node2 } = twoNodeClusterWithInterconnect();

    const before = await node1.executeCommand('ping -c 1 192.168.1.2');
    const beforeMs = Number(/time=([\d.]+)/.exec(before)?.[1] ?? 0);

    await node1.executeCommand('tc qdisc add dev eth1 root netem delay 200ms loss 10%');

    const after = await node1.executeCommand('ping -c 1 192.168.1.2');
    const afterMs = Number(/time=([\d.]+)/.exec(after)?.[1] ?? 0);

    expect(afterMs).toBeGreaterThan(beforeMs + 150);
    void node2;
  });

  it('Oracle wait events (gc buffer busy / gc cr request) correlate with the interconnect degradation', async () => {
    const { node1, node2 } = twoNodeClusterWithInterconnect();
    const s1 = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    s1.subShell.processLine('CREATE TABLE system.shared_counter (n NUMBER);');
    s1.subShell.processLine('INSERT INTO system.shared_counter VALUES (0);');
    s1.subShell.processLine('COMMIT;');

    await node1.executeCommand('tc qdisc add dev eth1 root netem delay 200ms loss 10%');

    const s2 = SqlPlusSubShell.create(node2, ['/', 'as', 'sysdba']);
    for (let i = 0; i < 20; i++) {
      s2.subShell.processLine('UPDATE system.shared_counter SET n = n + 1;');
      s2.subShell.processLine('COMMIT;');
    }
    s2.subShell.dispose();

    const waits = s1.subShell.processLine(
      "SELECT event, total_waits FROM v$system_event WHERE event IN ('gc buffer busy', 'gc cr request');"
    ).output.join('\n');
    expect(waits).toMatch(/gc buffer busy/);
    expect(Number(waits.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(0);

    const alert = s1.subShell.processLine('SELECT 1 FROM dual;');
    void alert;
    s1.subShell.dispose();
  });

  it('V$CLUSTER_INTERCONNECTS reflects the private interconnect and its degraded state', () => {
    const { node1 } = twoNodeClusterWithInterconnect();
    const s1 = SqlPlusSubShell.create(node1, ['/', 'as', 'sysdba']);
    const rows = s1.subShell.processLine('SELECT name, ip_address, source FROM v$cluster_interconnects;').output.join('\n');
    expect(rows).toMatch(/192\.168\.1\.1/);
    expect(rows).not.toMatch(/ORA-00942/);
    s1.subShell.dispose();
  });
});

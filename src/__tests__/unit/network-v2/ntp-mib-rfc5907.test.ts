/**
 * NTPv4-MIB (RFC 5907, mib-2 197) read over SNMP from a Cisco and a Huawei
 * router that follow a Cisco reference. The values must say what the CLI says
 * on the same machine at the same instant: the stratum of `show ntp status`,
 * the association of `show ntp associations`, the counters of the agent. The
 * object list, OIDs, ranges and enumerations come from docs/rfc/ntp/rfc5907.txt;
 * no real implementation was available to record (ntpsec dropped ntpsnmpd).
 * The read-write control objects and the notifications are not exposed: the
 * SNMP agent of this repository has no SET.
 *
 * Measured against HEAD (git worktree): all cases fall except the witness
 * (the lab synchronises, `snmpwalk` of system answers).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function run(device: { executeCommand(line: string): Promise<string> }, lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

async function lab(synchronise = true) {
  const reference = new CiscoRouter('R1');
  const cisco = new CiscoRouter('R2');
  const huawei = new HuaweiRouter('R3');
  const linux = new LinuxPC('L1');
  const sw = new GenericSwitch('switch-generic', 'SW');
  [reference.getPort('GigabitEthernet0/0')!, cisco.getPort('GigabitEthernet0/0')!, huawei.getPorts()[0], linux.getPort('eth0')!]
    .forEach((port, index) => new Cable(`c${index}`).connect(port, sw.getPorts()[index]));
  await run(reference, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
    'exit', 'ntp master 2', 'end']);
  await run(cisco, ['enable', 'configure terminal', 'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.0', 'no shutdown',
    'exit', 'snmp-server community public RO', ...(synchronise ? ['ntp server 10.0.0.1'] : ['ntp server 10.0.0.99']), 'end']);
  await run(huawei, ['system-view', 'interface GigabitEthernet0/0/0', 'ip address 10.0.0.3 255.255.255.0', 'undo shutdown', 'quit',
    'snmp-agent', 'snmp-agent community read public', ...(synchronise ? ['ntp-service unicast-server 10.0.0.1'] : []), 'return']);
  await linux.executeCommand('ip addr add 10.0.0.5/24 dev eth0');
  converge(clock, 400_000);
  return { cisco, huawei, linux };
}

const walk = (linux: LinuxPC, host: string, oid: string): Promise<string> => linux.executeCommand(`snmpwalk -v2c -c public -On ${host} ${oid}`);
const MIB = '.1.3.6.1.2.1.197.1';

describe('NTPv4-MIB against the CLI of the same machine', () => {
  it('witness: the lab synchronises and the router answers SNMP', async () => {
    const { cisco, linux } = await lab();
    expect(await cisco.executeCommand('show ntp status')).toContain('Clock is synchronized');
    expect(await walk(linux, '10.0.0.2', '1.3.6.1.2.1.1.1')).toContain('.1.3.6.1.2.1.1.1.0');
  });

  it('[fails before] the entity information and status say synchronised to a remote server at the CLI stratum', async () => {
    const { cisco, linux } = await lab();
    const output = await walk(linux, '10.0.0.2', '1.3.6.1.2.1.197.1.2');
    expect(output).toContain(`${MIB}.2.1.0 = INTEGER: 6`);
    expect(output).toContain(`${MIB}.2.2.0 = Gauge32: 3`);
    expect(output).toContain(`${MIB}.2.4.0 = STRING: "10.0.0.1"`);
    expect(output).toContain(`${MIB}.2.6.0 = Gauge32: 1`);
    expect(await cisco.executeCommand('show ntp status')).toContain('stratum 3, reference is 10.0.0.1');
  });

  it('[fails before] the association table is indexed by the association id and carries the stratum and address', async () => {
    const { linux } = await lab();
    const output = await walk(linux, '10.0.0.2', '1.3.6.1.2.1.197.1.3');
    expect(output).toMatch(new RegExp(`${MIB.replace(/\./g, '\\.')}\\.3\\.1\\.1\\.2\\.\\d+ = STRING: "10\\.0\\.0\\.1"`));
    expect(output).toMatch(/\.3\.1\.1\.4\.\d+ = INTEGER: 1/);
    expect(output).toMatch(/\.3\.1\.1\.7\.\d+ = Gauge32: 2/);
    expect(output).toMatch(/\.3\.2\.1\.2\.\d+ = Counter32: [1-9]/);
  });

  it('[fails before] the packet-mode table counts the client requests sent and the server replies received', async () => {
    const { linux } = await lab();
    const output = await walk(linux, '10.0.0.2', '1.3.6.1.2.1.197.1.2.17');
    expect(output).toMatch(/\.2\.17\.1\.2\.3 = Counter32: [1-9]/);
    expect(output).toMatch(/\.2\.17\.1\.3\.4 = Counter32: [1-9]/);
  });

  it('[fails before] an unsynchronised entity with a configured source is notSynchronized and its date/time is empty', async () => {
    const { linux } = await lab(false);
    const output = await walk(linux, '10.0.0.2', '1.3.6.1.2.1.197.1.2');
    expect(output).toContain(`${MIB}.2.1.0 = INTEGER: 2`);
    expect(output).toContain(`${MIB}.2.2.0 = Gauge32: 16`);
    expect(output).toMatch(/\.2\.9\.0 = (""|Hex-STRING: *)$/m);
  });

  it('[fails before] a Huawei router answers the same objects', async () => {
    const { linux } = await lab();
    const output = await walk(linux, '10.0.0.3', '1.3.6.1.2.1.197.1.2');
    expect(output).toContain(`${MIB}.2.1.0 = INTEGER: 6`);
    expect(output).toContain(`${MIB}.2.2.0 = Gauge32: 3`);
  });

  it('[fails before] an entity with nothing configured is noneConfigured', async () => {
    const { huawei, linux } = await lab();
    await run(huawei, ['system-view', 'undo ntp-service unicast-server 10.0.0.1', 'return']);
    converge(clock, 10_000);
    expect(await walk(linux, '10.0.0.3', '1.3.6.1.2.1.197.1.2.1')).toContain(`${MIB}.2.1.0 = INTEGER: 3`);
  });
});

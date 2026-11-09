/*
 * Probe: FortiOS 7.4.12 (system sdwan > config duplication, p.1950) documents SD-WAN duplication rules: `srcintf`, `dstintf`,
 * `srcaddr`, `dstaddr`, `service`, `packet-duplication [disable|force|on-demand]` and `packet-de-duplication`. None existed (battery
 * 10 test 454 typed `packet-duplication` on a service, a word that belongs to the duplication rule). A matching rule now sends a
 * copy of each forwarded packet out of every other member of the SD-WAN zone of the egress interface (`force`), and a rule with
 * `packet-de-duplication enable` makes the receiving unit discard a packet it already saw (same source, destination, protocol,
 * IP identification and ICMP/TCP sequence). The de-duplication match is made before routing, so `dstintf` cannot take part in it.
 * `on-demand` is refused: it needs the SLA of the member in use, which a duplication rule here does not reference.
 *
 * B's wan2 carries `src-check disable`: the copy arrives where the reverse route does not point.
 * PC1 -- A (zone overlay = wan1 + wan2) == two links == B -- PC2; PC2's frame counter measures what reaches it.
 * Discriminated with git stash on src/network: 3 of 5 fall before the change (force, de-duplication, on-demand refusal); the
 * witness (no rule: one copy per ping) and the non-matching-service case (a rule that does not match duplicates nothing) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function type(device: { executeCommand(c: string): Promise<string> }, lines: readonly string[]): Promise<string[]> {
  const replies: string[] = [];
  for (const line of lines) replies.push(await device.executeCommand(line));
  return replies;
}

const duplicationRule = (mode: string, extra: readonly string[] = []) => [
  'config system sdwan', 'config duplication', 'edit 1', 'set srcintf "port1"', `set packet-duplication ${mode}`, ...extra, 'next', 'end', 'end',
];

async function lab(aRule: readonly string[], bRule: readonly string[]) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  const pc1 = new LinuxPC('linux-pc', 'PC1', 0, 100);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 200, 100);
  pc1.powerOn(); pc2.powerOn();
  new Cable('p1').connect(pc1.getPorts()[0], a.getPort('port1')!);
  new Cable('l1').connect(a.getPort('wan1')!, b.getPort('wan1')!);
  new Cable('l2').connect(a.getPort('wan2')!, b.getPort('wan2')!);
  new Cable('p2').connect(b.getPort('port1')!, pc2.getPorts()[0]);
  const ifaces = (rows: readonly (readonly [string, string])[]) => [
    'config system interface', ...rows.flatMap(([name, ip]) => [`edit "${name}"`, 'set mode static', `set ip ${ip} 255.255.255.0`, 'set allowaccess ping', 'next']), 'end',
  ];
  const policy = (id: number, from: string, to: string) => [
    'config firewall policy', `edit ${id}`, `set srcintf "${from}"`, `set dstintf "${to}"`, 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end',
  ];
  await type(a, [
    ...ifaces([['port1', '10.0.1.1'], ['wan1', '10.1.1.1'], ['wan2', '10.1.2.1']]),
    'config system sdwan', 'set status enable',
    'config zone', 'edit "overlay"', 'next', 'end',
    'config members', 'edit 1', 'set interface "wan1"', 'set gateway 10.1.1.2', 'set zone "overlay"', 'next',
    'edit 2', 'set interface "wan2"', 'set gateway 10.1.2.2', 'set zone "overlay"', 'next', 'end', 'end',
    ...aRule,
    'config router static', 'edit 1', 'set dst 10.0.2.0 255.255.255.0', 'set gateway 10.1.1.2', 'set device "wan1"', 'next', 'end',
    ...policy(1, 'port1', 'overlay'), ...policy(2, 'overlay', 'port1'),
  ]);
  await type(b, [
    ...ifaces([['port1', '10.0.2.1'], ['wan1', '10.1.1.2'], ['wan2', '10.1.2.2']]),
    'config system interface', 'edit "wan2"', 'set src-check disable', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.0.1.0 255.255.255.0', 'set gateway 10.1.1.1', 'set device "wan1"', 'next', 'end',
    ...policy(1, 'wan1', 'port1'), ...policy(2, 'wan2', 'port1'), ...policy(3, 'port1', 'wan1'),
    ...(bRule.length > 0 ? ['config system sdwan', 'config duplication', 'edit 1', 'set srcintf "wan1" "wan2"', ...bRule, 'next', 'end', 'end'] : []),
  ]);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.1.10/24 dev eth0', 'ip route add default via 10.0.1.1']) await pc1.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.2.10/24 dev eth0', 'ip route add default via 10.0.2.1']) await pc2.executeCommand(line);
  return { a, b, pc1, pc2 };
}

async function deliveredToPc2(pc1: LinuxPC, pc2: LinuxPC): Promise<number> {
  await pc1.executeCommand('ping -c 1 10.0.2.10');
  const before = pc2.getPorts()[0].getCounters().framesIn;
  await pc1.executeCommand('ping -c 3 10.0.2.10');
  return pc2.getPorts()[0].getCounters().framesIn - before;
}

describe('sdwan duplication', () => {
  it('witness: with no rule each ping reaches PC2 once', async () => {
    const { pc1, pc2 } = await lab([], []);
    expect(await deliveredToPc2(pc1, pc2)).toBe(3);
  });

  it('force sends a copy of each packet over the other member', async () => {
    const { pc1, pc2 } = await lab(duplicationRule('force'), []);
    expect(await deliveredToPc2(pc1, pc2)).toBe(6);
  });

  it('packet-de-duplication on the far end discards the second copy', async () => {
    const { a, pc1, pc2 } = await lab(duplicationRule('force'), ['set packet-duplication disable', 'set packet-de-duplication enable']);
    expect(await deliveredToPc2(pc1, pc2)).toBe(3);
    expect(a.getPort('wan2')!.getCounters().framesOut).toBeGreaterThanOrEqual(3);
  });

  it('a rule whose service does not match duplicates nothing', async () => {
    const { pc1, pc2 } = await lab(duplicationRule('force', ['set service "HTTPS"']), []);
    expect(await deliveredToPc2(pc1, pc2)).toBe(3);
  });

  it('on-demand is refused naming the missing brick', async () => {
    const fw = new FortiGate('firewall-fortinet', 'F', 0, 0);
    const replies = await type(fw, ['config system sdwan', 'config duplication', 'edit 1', 'set packet-duplication on-demand']);
    expect(replies[3]).toMatch(/SLA of the member in use/);
  });
});

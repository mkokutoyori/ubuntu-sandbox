/*
 * Probe: FortiOS 7.4.12 documents `vrf` (Virtual Routing Forwarding ID, 0-251) on a system interface and on a static route. Neither
 * existed. A route now belongs to a VRF (a connected route to the VRF of its interface, a static one to its `vrf`), a packet is
 * routed in the table of its INGRESS interface's VRF (the reverse-path check too), and `get router info routing-table all` prints a
 * `Routing table for VRF=N` section for each VRF in use. Everything that did not name a VRF stays in VRF 0, where the unit's own
 * traffic and every existing view keep reading. Two interfaces in different VRFs therefore cannot reach each other through a
 * policy that allows it: a route in the other table does not exist.
 *
 * PC1 -- port1 FGT port2 -- PC2, an accept policy both ways.
 * Discriminated with git stash on src/network: 3 of 6 fall before the change (isolation, per-VRF sections, static route). Three pass
 * either way: the no-VRF witness, the same-non-zero-VRF case (before the change the word is refused and the ping crosses anyway)
 * and the range check (an unknown attribute is refused too).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function type(device: { executeCommand(c: string): Promise<string> }, lines: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await device.executeCommand(line));
  return out;
}

async function lab(vrf1: number, vrf2: number) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'PC1', -200, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 200, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, fgt.getPort('port1')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, fgt.getPort('port2')!);
  await type(pc1, ['ip addr add 10.1.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.1.0.1']);
  await type(pc2, ['ip addr add 10.2.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.2.0.1']);
  const replies = await type(fgt, [
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', `set vrf ${vrf1}`, 'next',
    'edit port2', 'set mode static', 'set ip 10.2.0.1 255.255.255.0', 'set allowaccess ping', `set vrf ${vrf2}`, 'next', 'end',
    ...[['1', 'port1', 'port2'], ['2', 'port2', 'port1']].flatMap(([id, from, to]) => [
      'config firewall policy', `edit ${id}`, `set srcintf "${from}"`, `set dstintf "${to}"`, 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set schedule "always"', 'set action accept', 'next', 'end']),
  ]);
  return { fgt, pc1, replies };
}

const ping = (pc: LinuxPC) => pc.executeCommand('ping -c 2 -W 1 10.2.0.10');

describe('vrf', () => {
  it('witness: with no VRF named the ping crosses the unit', async () => {
    const { pc1 } = await lab(0, 0);
    expect(await ping(pc1)).toMatch(/2 received/);
  });

  it('two interfaces in the same non-zero VRF still talk', async () => {
    const { pc1 } = await lab(5, 5);
    expect(await ping(pc1)).toMatch(/2 received/);
  });

  it('two interfaces in different VRFs cannot reach each other', async () => {
    const { pc1 } = await lab(1, 2);
    expect(await ping(pc1)).toMatch(/100% packet loss/);
  });

  it('the routing table prints one section per VRF in use', async () => {
    const { fgt } = await lab(1, 2);
    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table).toContain('Routing table for VRF=1');
    expect(table).toContain('Routing table for VRF=2');
    expect(table.split('Routing table for VRF=1')[1]).toContain('10.1.0.0/24');
    expect(table.split('Routing table for VRF=1')[1].split('Routing table for VRF=2')[0]).not.toContain('10.2.0.0/24');
  });

  it('a static route belongs to the VRF it names', async () => {
    const { fgt } = await lab(1, 1);
    await type(fgt, ['config router static', 'edit 1', 'set dst 192.168.99.0 255.255.255.0', 'set gateway 10.2.0.10', 'set device "port2"', 'set vrf 1', 'next', 'end']);
    const table = await fgt.executeCommand('get router info routing-table all');
    expect(table.split('Routing table for VRF=1')[1]).toContain('192.168.99.0/24');
    expect(table.split('Routing table for VRF=1')[0]).not.toContain('192.168.99.0/24');
  });

  it('the vrf range is checked', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'F', 0, 0);
    const replies = await type(fgt, ['config system interface', 'edit port1', 'set vrf 300']);
    expect(replies[2]).toMatch(/out of range|range|fail/i);
  });
});

/*
 * Probe: FortiOS 7.4.12 (router bgp > config vrf > config leak-target, p.1062 and p.1115) leaks the routes of an origin VRF into a
 * target VRF through `interface` and an optional `route-map`. The tables did not exist; with VRFs now real, two VRFs could not be
 * joined at all. A leak copies the routes of the origin VRF into the target table as BGP routes (distance 20) leaving by the leak
 * interface; the route-map (a prefix-list match) selects which, and a route-map that does not exist leaks nothing (fail closed).
 * Leaking is a BGP function, so a local AS is required. Route targets, route distinguishers, import maps and the ce/pe roles are
 * VPN VRF words this build does not evaluate and refuses.
 *
 * PC1 (VRF 1, port1) and PC2 (VRF 2, port2) behind one unit. The request is routed in the VRF of its ingress interface, so the
 * leak that matters is that of the destination VRF INTO the sender's VRF; the reply rides the session and needs none.
 * Discriminated with git stash on src/network: 5 of 8 fall before the change. Three pass either way and are isolation cases:
 * the no-leak witness, the wrong-way leak and the non-matching route-map (before the change nothing leaks at all).
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

const leak = (origin: number, target: number, iface: string, extra: readonly string[] = []) => [
  'config vrf', `edit ${origin}`, 'config leak-target', `edit ${target}`, `set interface "${iface}"`, ...extra, 'next', 'end', 'next', 'end',
];

const bgp = (...leaks: (readonly string[])[]) => ['config router bgp', 'set as 65000', ...leaks.flat(), 'end'];

const PREFIX_LIST = (prefix: string) => [
  'config router prefix-list', 'edit "p"', 'config rule', 'edit 1', `set prefix ${prefix} 255.255.255.0`, 'set action permit', 'next', 'end', 'next', 'end',
  'config router route-map', 'edit "rm"', 'config rule', 'edit 1', 'set match-ip-address "p"', 'next', 'end', 'next', 'end',
];

async function lab(commands: readonly string[]) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'PC1', -200, 0);
  const pc2 = new LinuxPC('linux-pc', 'PC2', 200, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, fgt.getPort('port1')!);
  new Cable('c2').connect(pc2.getPort('eth0')!, fgt.getPort('port2')!);
  await type(pc1, ['ip addr add 10.1.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.1.0.1']);
  await type(pc2, ['ip addr add 10.2.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.2.0.1']);
  const replies = await type(fgt, [
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'set vrf 1', 'next',
    'edit port2', 'set mode static', 'set ip 10.2.0.1 255.255.255.0', 'set allowaccess ping', 'set vrf 2', 'next', 'end',
    ...[['1', 'port1', 'port2'], ['2', 'port2', 'port1']].flatMap(([id, from, to]) => [
      'config firewall policy', `edit ${id}`, `set srcintf "${from}"`, `set dstintf "${to}"`, 'set srcaddr "all"', 'set dstaddr "all"',
      'set service "ALL"', 'set schedule "always"', 'set action accept', 'next', 'end']),
    ...commands,
  ]);
  return { fgt, pc1, replies };
}

const ping = (pc: LinuxPC) => pc.executeCommand('ping -c 2 -W 1 10.2.0.10');
const BOTH = [leak(1, 2, 'port1'), leak(2, 1, 'port2')];

describe('bgp vrf leaking', () => {
  it('witness: with no leak the two VRFs are isolated', async () => {
    const { pc1 } = await lab([]);
    expect(await ping(pc1)).toMatch(/100% packet loss/);
  });

  it('a leak in both directions joins the two VRFs', async () => {
    const { pc1 } = await lab(bgp(...BOTH));
    expect(await ping(pc1)).toMatch(/2 received/);
  });

  it('the leak that matters is the one INTO the sender VRF: the reply rides the session', async () => {
    const wrongWay = await lab(bgp(leak(1, 2, 'port1')));
    expect(await ping(wrongWay.pc1)).toMatch(/100% packet loss/);
  });

  it('a single leak of the destination VRF into the sender VRF is enough for a ping', async () => {
    const { pc1 } = await lab(bgp(leak(2, 1, 'port2')));
    expect(await ping(pc1)).toMatch(/2 received/);
  });

  it('the leaked route appears in the target VRF section as a BGP route', async () => {
    const { fgt } = await lab(bgp(...BOTH));
    const table = await fgt.executeCommand('get router info routing-table all');
    const vrf2 = table.split('Routing table for VRF=2')[1];
    expect(vrf2).toMatch(/B\s+10\.1\.0\.0\/24/);
  });

  it('a route-map selects the leaked routes: a matching prefix passes', async () => {
    const { pc1 } = await lab([...PREFIX_LIST('10.2.0.0'), ...bgp(leak(2, 1, 'port2', ['set route-map "rm"']))]);
    expect(await ping(pc1)).toMatch(/2 received/);
  });

  it('a route-map that does not match leaks nothing', async () => {
    const { pc1 } = await lab([...PREFIX_LIST('172.31.0.0'), ...bgp(leak(2, 1, 'port2', ['set route-map "rm"']))]);
    expect(await ping(pc1)).toMatch(/100% packet loss/);
  });

  it('leaking needs an AS, and the VPN words are refused', async () => {
    const { replies } = await lab(['config router bgp', ...leak(1, 2, 'port1'), 'end']);
    expect(replies.join('\n')).toMatch(/a local AS number is required/);
    const fgt = new FortiGate('firewall-fortinet', 'F', 0, 0);
    const refused = await type(fgt, ['config router bgp', 'config vrf', 'edit 1', 'set export-rt "65000:1"', 'set role pe']);
    expect(refused[3]).toMatch(/route targets, route distinguishers/);
    expect(refused[4]).toMatch(/route targets, route distinguishers/);
  });
});

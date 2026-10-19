/**
 * firewall address `set type mac` / `set macaddr`: a policy whose source
 * address is a MAC object matches on the source MAC of the frame that carried
 * the packet, and only there (a MAC object as destination never matches, it
 * fails closed).
 *
 * Measured on a git worktree of HEAD before the change: 1 of 4 falls (the
 * policy on another MAC must block). The 3 others pass either way: the `all`
 * witness; and the two "lets it through" cases, because the refused type
 * leaves the policy on its default source `all`, so they pass for the
 * opposite reason and only the blocking case proves the MAC is evaluated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

async function run(d: { executeCommand(c: string): Promise<string> }, cmds: string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function lab(macOf: (own: string) => string[]) {
  const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', -200, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 200, 0);
  new Cable('lan').connect(pc.getPort('eth0')!, fgt.getPort('port2')!);
  new Cable('dmz').connect(fgt.getPort('port3')!, srv.getPort('eth0')!);
  const own = pc.getPort('eth0')!.getMAC().toString();
  await run(pc, ['ip addr add 192.168.10.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.10.1']);
  await run(srv, ['ip addr add 192.168.20.10/24 dev eth0', 'ip link set eth0 up',
    'ip route add default via 192.168.20.1']);
  const macs = macOf(own);
  await run(fgt, [
    'config system interface', 'edit port2', 'set mode static',
    'set ip 192.168.10.1 255.255.255.0', 'set allowaccess ping', 'next',
    'edit port3', 'set mode static', 'set ip 192.168.20.1 255.255.255.0', 'next', 'end',
    ...(macs.length === 0 ? [] : [
      'config firewall address', 'edit "WORKSTATIONS"', 'set type mac',
      `set macaddr ${macs.map(m => `"${m}"`).join(' ')}`, 'next', 'end']),
    'config firewall policy', 'edit 1', 'set srcintf "port2"', 'set dstintf "port3"',
    `set srcaddr "${macs.length === 0 ? 'all' : 'WORKSTATIONS'}"`, 'set dstaddr "all"',
    'set service "ALL"', 'set action accept', 'next', 'end',
  ]);
  return () => pc.executeCommand('ping -c 1 192.168.20.10');
}

describe('address type mac', () => {
  it('witness: with srcaddr all the client reaches the server', async () => {
    expect(await (await lab(() => []))()).toMatch(/, 0% packet loss/);
  });

  it('a policy on the client MAC lets it through', async () => {
    expect(await (await lab(own => [own]))()).toMatch(/, 0% packet loss/);
  });

  it('a policy on a MAC range holding the client lets it through', async () => {
    const reach = await lab(own => [`${own.slice(0, 15)}00-${own.slice(0, 15)}ff`]);
    expect(await reach()).toMatch(/, 0% packet loss/);
  });

  it('a policy on another MAC blocks the client', async () => {
    expect(await (await lab(() => ['02:aa:bb:cc:dd:ee']))()).toMatch(/100% packet loss/);
  });
});

/**
 * `ip dhcp ping packets <n>` / `ip dhcp ping timeout <ms>` — the server is
 * supposed to ICMP-probe a candidate address before offering it, so a host
 * that already holds the address outside of DHCP (never leased, so the
 * server's own binding table has no idea) doesn't get double-assigned.
 * `DHCPServer.addConflict()` existed but nothing ever called it outside of
 * test hooks/reactive DHCPDECLINE handling — this covers the proactive path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Hub } from '@/network/devices/Hub';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

const dhcpState = (h: LinuxPC, iface: string) => h.getDHCPClient().getState(iface);

async function buildLab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const rogue = new LinuxPC('linux-pc', 'ROGUE');
  const r1 = new CiscoRouter('R1');
  const hub = new Hub('HUB', 4);
  new Cable('a').connect(h1.getPort('eth0')!, hub.getPort('eth0')!);
  new Cable('b').connect(rogue.getPort('eth0')!, hub.getPort('eth1')!);
  new Cable('c').connect(r1.getPort('GigabitEthernet0/0')!, hub.getPort('eth2')!);

  await run(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp ping packets 2',
    'ip dhcp ping timeout 200',
    'ip dhcp pool LAN', 'network 10.0.0.0 255.255.255.0', 'default-router 10.0.0.1', 'exit',
    'ip dhcp excluded-address 10.0.0.1',
    'end',
  ]);
  await rogue.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');

  return { h1, rogue, r1 };
}

describe('DHCP — proactive ping-before-offer conflict detection', () => {
  it('skips an address already held by a non-DHCP host and records a ping conflict', async () => {
    const { h1, r1 } = await buildLab();

    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');

    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).not.toBe('10.0.0.2');

    const conflicts = r1._getDHCPServerInternal().getConflicts();
    expect(conflicts.some(c => c.ipAddress === '10.0.0.2' && c.detectionMethod === 'ping')).toBe(true);
  });

  it('does not ping-check when ip dhcp ping packets is explicitly 0', async () => {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const r1 = new CiscoRouter('R1');
    new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    await run(r1, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp ping packets 0',
      'ip dhcp pool LAN', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1', 'exit',
      'ip dhcp excluded-address 10.0.1.1',
      'end',
    ]);

    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');
    expect(r1._getDHCPServerInternal().getConflicts().length).toBe(0);
  });
});

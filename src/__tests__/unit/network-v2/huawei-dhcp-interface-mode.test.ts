/**
 * Huawei router `dhcp select interface` mode: an interface can serve DHCP
 * directly from its own configured subnet (no named `ip pool` needed), with
 * per-interface `dhcp server dns-list` / `dhcp server lease` / `dhcp server
 * static-bind`. These were previously recorded only in a cosmetic
 * `_dhcpInterfaceExtras` map (surfaced by `display dhcp server interface`)
 * and never reached the real DHCPServer engine, so a client attached to
 * such an interface got no lease at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
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
  const r1 = new HuaweiRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GE0/0/0')!);

  await run(r1, [
    'system-view',
    'dhcp enable',
    'interface GigabitEthernet0/0/0',
    'ip address 10.5.0.1 255.255.255.0',
    'undo shutdown',
    'dhcp select interface',
    'dhcp server dns-list 9.9.9.9',
    'dhcp server lease day 2',
    'quit',
    'return',
  ]);

  return { h1, r1 };
}

describe('Huawei DHCP — interface mode serves real leases from per-interface config', () => {
  it('a client on the interface gets a real lease from the interface subnet with the configured DNS', async () => {
    const { h1 } = await buildLab();

    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');

    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.5\.0\./);
    expect(state.lease?.defaultGateway).toBe('10.5.0.1');
    expect(state.lease?.dnsServers).toContain('9.9.9.9');
  });

  it('honours the per-interface lease duration', async () => {
    const { h1 } = await buildLab();
    await h1.executeCommand('dhclient -v eth0');
    const state = dhcpState(h1, 'eth0');
    expect(state.lease?.leaseDuration).toBe(2 * 86400);
  });

  it('a static-bind on the interface pool reserves that IP for the matching client', async () => {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const r1 = new HuaweiRouter('R1');
    new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GE0/0/0')!);
    const clientMac = h1.getPort('eth0')!.getMAC().toString();

    await run(r1, [
      'system-view',
      'dhcp enable',
      'interface GigabitEthernet0/0/0',
      'ip address 10.5.0.1 255.255.255.0',
      'undo shutdown',
      'dhcp select interface',
      `dhcp server static-bind ip-address 10.5.0.77 mac-address ${clientMac}`,
      'quit',
      'return',
    ]);

    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');
    expect(dhcpState(h1, 'eth0').lease?.ipAddress).toBe('10.5.0.77');
  });
});

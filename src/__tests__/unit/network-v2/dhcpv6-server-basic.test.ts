/**
 * DHCPv6 (RFC 8415): `ipv6 dhcp pool` / `address prefix` / `dns-server` /
 * `ipv6 dhcp server <pool>` were pure CLI scaffolding — they populated a
 * free-form Map that nothing ever read back, so a client could never
 * actually obtain an address via DHCPv6. This covers the real
 * SOLICIT->ADVERTISE->REQUEST->REPLY exchange against a directly-attached
 * client.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

async function buildLab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);

  await run(r1, [
    'enable', 'configure terminal',
    'ipv6 unicast-routing',
    'interface GigabitEthernet0/0',
    'ipv6 address 2001:db8:1::1/64',
    'no shutdown', 'exit',
    'ipv6 dhcp pool POOL1',
    'address prefix 2001:db8:1::/64 lifetime 3600 1800',
    'dns-server 2001:4860:4860::8888',
    'domain-name test.lab',
    'exit',
    'interface GigabitEthernet0/0',
    'ipv6 dhcp server POOL1',
    'exit',
    'end',
  ]);

  return { h1, r1 };
}

describe('DHCPv6 — real server-side SOLICIT/ADVERTISE/REQUEST/REPLY', () => {
  it('a directly-attached client obtains a real address from the configured prefix', async () => {
    const { h1 } = await buildLab();
    const out = await h1.executeCommand('dhclient -6 -v eth0');
    expect(out).toContain('DHCPv6 REPLY');

    const port = h1.getPort('eth0')!;
    const addrs = port.getIPv6Addresses().filter(a => a.origin === 'dhcpv6');
    expect(addrs.length).toBe(1);
    expect(addrs[0].address.toString()).toMatch(/^2001:db8:1:/);
  });

  it('the router binding table reflects the lease', async () => {
    const { h1, r1 } = await buildLab();
    await h1.executeCommand('dhclient -6 eth0');

    const bindings = r1._getDHCPv6ServerInternal().getBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0].address).toMatch(/^2001:db8:1:/);
  });

  it('two different clients get two different addresses', async () => {
    const { h1, r1 } = await buildLab();
    const h2 = new LinuxPC('linux-pc', 'H2');
    new Cable('b').connect(h2.getPort('eth0')!, r1.getPort('GigabitEthernet0/1')!);
    await run(r1, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:1::2/64', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ipv6 dhcp server POOL1', 'exit',
      'end',
    ]);

    await h1.executeCommand('dhclient -6 eth0');
    await h2.executeCommand('dhclient -6 eth0');

    const a1 = h1.getPort('eth0')!.getIPv6Addresses().find(a => a.origin === 'dhcpv6')!.address.toString();
    const a2 = h2.getPort('eth0')!.getIPv6Addresses().find(a => a.origin === 'dhcpv6')!.address.toString();
    expect(a1).not.toBe(a2);
  });
});

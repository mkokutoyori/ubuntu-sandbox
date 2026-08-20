/**
 * Huawei DHCPv6: `dhcpv6 pool` / `address prefix` / `dns-server` /
 * `dhcpv6 server <pool>` were pure CLI scaffolding (a free-form Map
 * nothing ever read back). Mirrors dhcpv6-server-basic.test.ts's Cisco
 * coverage for the same real SOLICIT->ADVERTISE->REQUEST->REPLY engine.
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

describe('Huawei DHCPv6 — real server-side SOLICIT/ADVERTISE/REQUEST/REPLY', () => {
  it('a directly-attached client obtains a real address from the configured prefix', async () => {
    const h1 = new LinuxPC('linux-pc', 'H1');
    const r1 = new HuaweiRouter('R1');
    new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GE0/0/0')!);

    await run(r1, [
      'system-view',
      'dhcpv6 pool V6POOL',
      'address prefix 2001:db8:1::/64',
      'dns-server 2001:4860:4860::8888',
      'dns-domain-name v6.lab',
      'interface GigabitEthernet0/0/0',
      'ipv6 enable',
      'ipv6 address 2001:db8:1::1/64',
      'dhcpv6 server V6POOL',
      'undo shutdown',
      'quit',
    ]);

    const out = await h1.executeCommand('dhclient -6 -v eth0');
    expect(out).toContain('DHCPv6 REPLY');

    const addrs = h1.getPort('eth0')!.getIPv6Addresses().filter(a => a.origin === 'dhcpv6');
    expect(addrs.length).toBe(1);
    expect(addrs[0].address.toString()).toMatch(/^2001:db8:1:/);

    const bindings = r1._getDHCPv6ServerInternal().getBindings();
    expect(bindings.length).toBe(1);
  });
});

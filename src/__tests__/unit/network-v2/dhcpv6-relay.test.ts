/**
 * DHCPv6 relay (RFC 8415 §7/§19): `ipv6 dhcp relay destination` on a router
 * that isn't the DHCPv6 server itself must wrap the client's SOLICIT/REQUEST
 * in RELAY-FORW (real link-address + hop-count), unicast it to the central
 * server, and unwrap the server's RELAY-REPL back onto the client's link.
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
  const relay = new CiscoRouter('RELAY');
  const server = new CiscoRouter('SERVER');
  new Cable('a').connect(h1.getPort('eth0')!, relay.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(relay.getPort('GigabitEthernet0/1')!, server.getPort('GigabitEthernet0/0')!);

  await run(relay, [
    'enable', 'configure terminal',
    'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown',
    'ipv6 dhcp relay destination 2001:db8:99::2', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:99::1/64', 'no shutdown', 'exit',
    'end',
  ]);

  await run(server, [
    'enable', 'configure terminal',
    'ipv6 unicast-routing',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:99::2/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:1::/64 2001:db8:99::1',
    'ipv6 dhcp pool POOL1',
    'address prefix 2001:db8:1::/64 lifetime 3600 1800',
    'dns-server 2001:4860:4860::8888',
    'exit',
    'end',
  ]);

  return { h1, relay, server };
}

describe('DHCPv6 relay — real RELAY-FORW/RELAY-REPL through a relay agent', () => {
  it('a client behind the relay obtains a real lease from the central server', async () => {
    const { h1 } = await buildLab();
    const out = await h1.executeCommand('dhclient -6 -v eth0');
    expect(out).toContain('DHCPv6 REPLY');

    const addrs = h1.getPort('eth0')!.getIPv6Addresses().filter(a => a.origin === 'dhcpv6');
    expect(addrs.length).toBe(1);
    expect(addrs[0].address.toString()).toMatch(/^2001:db8:1:/);
  });

  it('the central server (not the relay) holds the binding', async () => {
    const { h1, server } = await buildLab();
    await h1.executeCommand('dhclient -6 eth0');

    const bindings = server._getDHCPv6ServerInternal().getBindings();
    expect(bindings.length).toBe(1);
    expect(bindings[0].address).toMatch(/^2001:db8:1:/);
  });
});

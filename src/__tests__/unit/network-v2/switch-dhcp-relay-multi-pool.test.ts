/**
 * Genuine wire-level DHCP relay from an L3 switch SVI (`ip helper-address`):
 * real giaddr stamping + hop-count, not the topological shortcut where
 * EndHost.autoDiscoverDHCPServers registers the upstream server directly
 * in-memory (DirectServerChannel) regardless of subnet. That shortcut never
 * carries a giaddr, so with two remote pools behind the same relay target
 * it cannot possibly hand each VLAN's client the right subnet — only a
 * real relayed DISCOVER (giaddr = the client's own SVI) lets the central
 * server's existing subnet-anchored pool selection (see
 * dhcp-local-multi-pool-selection.test.ts) pick correctly.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

// VLAN20's pool is declared FIRST on the central server so a shortcut that
// can't tell the two VLANs apart (no giaddr) would be exposed immediately.
async function buildLab() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const h2 = new LinuxPC('linux-pc', 'H2');
  const sw = new CiscoSwitch('cs', 'SW1', 26);
  const r1 = new CiscoRouter('R1');

  new Cable('a').connect(h1.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  new Cable('b').connect(h2.getPort('eth0')!, sw.getPort('FastEthernet0/2')!);
  new Cable('c').connect(sw.getPort('GigabitEthernet0/1')!, r1.getPort('GigabitEthernet0/0')!);

  await run(sw, [
    'enable', 'configure terminal',
    'ip routing',
    'vlan 10', 'exit',
    'vlan 20', 'exit',
    'vlan 99', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20', 'exit',
    'interface GigabitEthernet0/1', 'switchport mode access', 'switchport access vlan 99', 'exit',
    'interface Vlan10', 'ip address 10.0.10.1 255.255.255.0', 'ip helper-address 10.0.99.2', 'no shutdown', 'exit',
    'interface Vlan20', 'ip address 10.0.20.1 255.255.255.0', 'ip helper-address 10.0.99.2', 'no shutdown', 'exit',
    'interface Vlan99', 'ip address 10.0.99.1 255.255.255.252', 'no shutdown', 'exit',
    'end',
  ]);

  await run(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.99.2 255.255.255.252', 'no shutdown', 'exit',
    'ip route 10.0.10.0 255.255.255.0 10.0.99.1',
    'ip route 10.0.20.0 255.255.255.0 10.0.99.1',
    'ip dhcp pool VLAN20', 'network 10.0.20.0 255.255.255.0', 'default-router 10.0.20.1', 'exit',
    'ip dhcp pool VLAN10', 'network 10.0.10.0 255.255.255.0', 'default-router 10.0.10.1', 'exit',
    'ip dhcp excluded-address 10.0.10.1',
    'ip dhcp excluded-address 10.0.20.1',
    'end',
  ]);

  return { h1, h2, sw, r1 };
}

describe('L3 switch DHCP relay — real giaddr picks the right remote pool per VLAN', () => {
  it('a VLAN10 client gets a VLAN10 address relayed through the switch SVI', async () => {
    const { h1 } = await buildLab();
    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');
    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.0\.10\./);
    expect(state.lease?.defaultGateway).toBe('10.0.10.1');
  });

  it('a VLAN20 client gets a VLAN20 address relayed through the switch SVI', async () => {
    const { h2 } = await buildLab();
    const out = await h2.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');
    const state = dhcpState(h2, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.0\.20\./);
    expect(state.lease?.defaultGateway).toBe('10.0.20.1');
  });

  it('the central server sees the relayed DISCOVER with a real giaddr (not a direct in-memory registration)', async () => {
    const { h1, r1 } = await buildLab();
    await h1.executeCommand('dhclient eth0');
    const binding = await r1.executeCommand('show ip dhcp binding');
    expect(binding).toMatch(/10\.0\.10\.\d+/);
  });
});

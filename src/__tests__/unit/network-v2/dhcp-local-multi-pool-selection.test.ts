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

const dhcpState = (h: LinuxPC, iface: string) => h.getDHCPClient().getState(iface);

// Two directly-attached subnets on the same router, no relay/helper-address
// involved at all — each interface is the local gateway for its own pool.
// The VLAN20 pool is declared FIRST so a naive "first pool with a free
// address wins" selection (ignoring which interface the DISCOVER actually
// arrived on) would hand a VLAN10-side client a VLAN20 address.
async function buildTwoSubnetRouter() {
  const h1 = new LinuxPC('linux-pc', 'H1');
  const h2 = new LinuxPC('linux-pc', 'H2');
  const r1 = new CiscoRouter('R1');
  new Cable('a').connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(h2.getPort('eth0')!, r1.getPort('GigabitEthernet0/1')!);
  await run(r1, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.10.0.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.20.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool VLAN20', 'network 10.20.0.0 255.255.255.0', 'default-router 10.20.0.1', 'exit',
    'ip dhcp pool VLAN10', 'network 10.10.0.0 255.255.255.0', 'default-router 10.10.0.1', 'exit',
    'ip dhcp excluded-address 10.10.0.1',
    'ip dhcp excluded-address 10.20.0.1',
    'end',
  ]);
  return { h1, h2, r1 };
}

describe('DHCP — local (non-relayed) multi-pool selection on a directly-attached router', () => {
  it('gives a VLAN10-attached client a VLAN10 address, not whichever pool happens to iterate first', async () => {
    const { h1 } = await buildTwoSubnetRouter();

    const out = await h1.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');

    const state = dhcpState(h1, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.10\.0\./);
    expect(state.lease?.defaultGateway).toBe('10.10.0.1');
  });

  it('gives a VLAN20-attached client a VLAN20 address', async () => {
    const { h2 } = await buildTwoSubnetRouter();

    const out = await h2.executeCommand('dhclient -v eth0');
    expect(out).toContain('DHCPACK');

    const state = dhcpState(h2, 'eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.20\.0\./);
    expect(state.lease?.defaultGateway).toBe('10.20.0.1');
  });

  it('both directly-attached clients are correctly segregated when leased back-to-back', async () => {
    const { h1, h2 } = await buildTwoSubnetRouter();

    await h1.executeCommand('dhclient eth0');
    await h2.executeCommand('dhclient eth0');

    expect(dhcpState(h1, 'eth0').lease?.ipAddress).toMatch(/^10\.10\.0\./);
    expect(dhcpState(h2, 'eth0').lease?.ipAddress).toMatch(/^10\.20\.0\./);
    expect(await h1.executeCommand('ping -c 1 10.10.0.1')).toContain('0% packet loss');
    expect(await h2.executeCommand('ping -c 1 10.20.0.1')).toContain('0% packet loss');
  });
});

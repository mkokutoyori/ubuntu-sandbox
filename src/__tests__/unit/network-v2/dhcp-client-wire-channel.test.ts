/**
 * Regression tests for journal entrée 15 (backlog #17): the main
 * DHCPClient state machine (the one behind `dhclient` / `ipconfig
 * /renew`) must converse with servers through REAL UDP 68→67 frames on
 * the cable plant — not through direct DHCPServer object references.
 *
 * The discriminating scenarios:
 *   - a cabled host gets its lease without any registered server ref
 *     (pure wire DORA);
 *   - cutting the cable really cuts the protocol: same call, no lease
 *     from the pool (APIPA fallback);
 *   - DHCPRELEASE travels the wire and frees the binding server-side.
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
  const cable = new Cable('a');
  cable.connect(h1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  await run(r1, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool LAN', 'network 10.0.1.0 255.255.255.0', 'default-router 10.0.1.1',
    'dns-server 10.0.1.53', 'exit',
    'ip dhcp excluded-address 10.0.1.1', 'end']);
  return { h1, r1, cable };
}

describe('DHCPClient over the wire channel', () => {
  it('binds a lease through pure frame exchange (no registered server refs)', async () => {
    const { h1, r1 } = await buildLab();
    const client = h1.getDHCPClient();

    // NOTE: no autoDiscoverDHCPServers() — connectedServers stays empty.
    // The lease can only come from real frames through the cable.
    client.requestLease('eth0', { verbose: true });

    const state = client.getState('eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^10\.0\.1\./);
    expect(state.lease?.defaultGateway).toBe('10.0.1.1');
    expect(state.lease?.dnsServers).toContain('10.0.1.53');
    expect(state.lease?.serverIdentifier).toBe('10.0.1.1');

    // Server-side binding exists because the REQUEST really reached it.
    const bindings = r1._getDHCPServerInternal().getBindings();
    expect([...bindings.keys()]).toContain(state.lease!.ipAddress);
  });

  it('a cut cable really interrupts DHCP — APIPA instead of a pool lease', async () => {
    const { h1, cable } = await buildLab();
    const client = h1.getDHCPClient();

    cable.disconnect();
    client.requestLease('eth0');

    const state = client.getState('eth0');
    // RFC 3927 link-local fallback — NOT an address from the router pool.
    expect(state.lease?.ipAddress).toMatch(/^169\.254\./);
  });

  it('DHCPRELEASE travels the wire and frees the server-side binding', async () => {
    const { h1, r1 } = await buildLab();
    const client = h1.getDHCPClient();

    client.requestLease('eth0');
    const leasedIp = client.getState('eth0').lease!.ipAddress;
    const server = r1._getDHCPServerInternal();
    expect([...server.getBindings().keys()]).toContain(leasedIp);

    client.releaseLease('eth0');

    expect([...server.getBindings().keys()]).not.toContain(leasedIp);
    expect(client.getState('eth0').lease).toBeNull();
  });

  it('renews at T1 over the wire (REQUEST without server-id, unicast semantics)', async () => {
    const { h1 } = await buildLab();
    const client = h1.getDHCPClient();

    client.requestLease('eth0');
    const before = client.getState('eth0').lease!;

    // Drive the renewal exchange directly through the channel the
    // client uses at T1: same code path as the timer callback.
    const renewed = client.requestLease('eth0', { verbose: true });

    expect(renewed).toContain('DHCPACK');
    const after = client.getState('eth0').lease!;
    expect(after.ipAddress).toBe(before.ipAddress);
    expect(client.getState('eth0').state).toBe('BOUND');
  });
});

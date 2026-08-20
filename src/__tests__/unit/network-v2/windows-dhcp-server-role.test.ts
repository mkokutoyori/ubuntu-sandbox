/**
 * PRD-Windows-Server.md §5 P8 — DHCP Server role core: `WindowsDhcpServerRole`
 * hosts the real DHCP engine (src/network/dhcp/DHCPServer.ts) over genuine
 * UDP 67/68 — scopes, exclusions, reservations, options, and real clients
 * (Linux/Windows) obtaining leases through the actual wire protocol, reusing
 * the same engine `Router` hosts (no lease logic reimplemented).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { WindowsDhcpServerRole } from '@/network/devices/windows/server/dhcp/WindowsDhcpServerRole';
import type { EndHost } from '@/network/devices/EndHost';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function topology() {
  const server = new LinuxPC('linux-pc', 'DHCPHOST');
  const client = new LinuxPC('linux-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.70.10'), mask);
  return { server: server as unknown as EndHost, client };
}

describe('WindowsDhcpServerRole — scope admin surface', () => {
  it('creates a scope and reads it back', () => {
    const { server } = topology();
    const role = new WindowsDhcpServerRole(server);
    const res = role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    expect(res.ok).toBe(true);
    const scope = role.getScope('LAN')!;
    expect(scope.startRange).toBe('192.168.70.100');
    expect(scope.endRange).toBe('192.168.70.200');
    expect(scope.subnetMask).toBe('255.255.255.0');
  });

  it('refuses a duplicate scope name', () => {
    const { server } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    const res = role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    expect(res.ok).toBe(false);
  });

  it('lists scopes', () => {
    const { server } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    role.addScope('GUEST', '192.168.71.100', '192.168.71.200', '255.255.255.0');
    expect(role.listScopes().map(s => s.name).sort()).toEqual(['GUEST', 'LAN']);
  });
});

describe('WindowsDhcpServerRole — real UDP 67/68 leasing', () => {
  it('a real client obtains a lease within the configured range', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    role.setOptionValue('LAN', 3, ['192.168.70.1']);
    role.setOptionValue('LAN', 6, ['192.168.70.53']);

    client.getDHCPClient().requestLease('eth0', { verbose: true });
    const state = client.getDHCPClient().getState('eth0');
    expect(state.state).toBe('BOUND');
    expect(state.lease?.ipAddress).toMatch(/^192\.168\.70\.(1[0-9][0-9]|200)$/);
    expect(state.lease?.defaultGateway).toBe('192.168.70.1');
    expect(state.lease?.dnsServers).toContain('192.168.70.53');
  });

  it('confines allocation to the configured start/end range (exclusion of the rest of the subnet)', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.start();
    role.addScope('LAN', '192.168.70.150', '192.168.70.150', '255.255.255.0');

    client.getDHCPClient().requestLease('eth0');
    const state = client.getDHCPClient().getState('eth0');
    expect(state.lease?.ipAddress).toBe('192.168.70.150');
  });

  it('the leased address is visible via Get-DhcpServerv4Lease (getLeases)', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');

    client.getDHCPClient().requestLease('eth0');
    const state = client.getDHCPClient().getState('eth0');

    const leases = role.getLeases('LAN');
    expect(leases.some(l => l.ipAddress === state.lease?.ipAddress)).toBe(true);
  });

  it('a reserved MAC always receives its reserved address', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    const clientMac = client.getPorts()[0].getMAC().toString();
    role.addReservation('LAN', '192.168.70.150', clientMac);

    client.getDHCPClient().requestLease('eth0');
    const state = client.getDHCPClient().getState('eth0');
    expect(state.lease?.ipAddress).toBe('192.168.70.150');
  });

  it('stops leasing once stop() is called', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');
    role.stop();

    client.getDHCPClient().requestLease('eth0', { timeout: 1 });
    const state = client.getDHCPClient().getState('eth0');
    expect(state.state).not.toBe('BOUND');
  });
});

describe('WindowsDhcpServerRole — simulated AD authorization', () => {
  it('an unauthorized server in a domain context serves no leases', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.setDomainContext(true);
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');

    client.getDHCPClient().requestLease('eth0', { timeout: 1 });
    const state = client.getDHCPClient().getState('eth0');
    expect(state.state).not.toBe('BOUND');
  });

  it('Add-DhcpServerInDC (authorizeInDC) lets a domain-context server start leasing', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.setDomainContext(true);
    role.authorizeInDC();
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');

    client.getDHCPClient().requestLease('eth0');
    const state = client.getDHCPClient().getState('eth0');
    expect(state.state).toBe('BOUND');
  });

  it('with no domain context, serving is authorized by default', () => {
    const { server, client } = topology();
    const role = new WindowsDhcpServerRole(server);
    role.start();
    role.addScope('LAN', '192.168.70.100', '192.168.70.200', '255.255.255.0');

    client.getDHCPClient().requestLease('eth0');
    const state = client.getDHCPClient().getState('eth0');
    expect(state.state).toBe('BOUND');
  });
});

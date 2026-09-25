/*
 * Probe — a FortiGate interface with `dhcp-relay-service enable` relays the
 * LAN's DHCP broadcasts to the server named by `dhcp-relay-ip`, and brings
 * the server's answer back to the client, on the wire.
 *
 * Before: `set dhcp-relay-service`, `set dhcp-relay-ip` and `set
 * dhcp-relay-type` were unknown attributes under `config system interface`
 * (FortiGate battery 02, tests 77 and 78): a LAN behind the firewall could
 * not lease from a server on another segment.
 *
 * Authority: FortiOS CLI reference, `config system interface`:
 * `dhcp-relay-service {enable|disable}`, `dhcp-relay-ip` (quoted list of
 * server addresses), `dhcp-relay-type {regular|ipsec}`; RFC 1542 / RFC 2131
 * §4.1: the relay sets giaddr to the receiving interface, increments hops,
 * unicasts to the server, and the server answers the relay at giaddr. The
 * relay logic is the router's (`ip helper-address`), now shared through
 * dhcp/DhcpRelay.ts. An `ipsec` relay is not modelled: such an interface
 * relays nothing (fail closed) rather than behave as a regular relay.
 * ISC dhcpd serves every declared subnet, the relayed ones included, and
 * picks the pool by giaddr; the simulated dhcpd only built pools for the
 * subnets of its own interfaces and answered relayed requests with
 * nothing — fixed in the same change.
 *
 * Measured before the change (git stash of src/network): 3 of the 6 cases
 * fail.
 * Passing either way:
 *   - "the server serves its own segment" is the WITNESS: dhcpd, its
 *     configuration and dhclient are sound.
 *   - "without the relay the LAN client gets nothing" and "an ipsec relay
 *     does not relay regular broadcasts" are non-regression: nothing was
 *     relayed before either.
 */
import { describe, it, expect } from 'vitest';
import { createDevice } from '@/network/devices/DeviceFactory';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper } from '../../new_firewall/fortigateBatteryHarness';

const DHCPD_CONF = [
  'authoritative;',
  'default-lease-time 600;',
  'max-lease-time 7200;',
  'subnet 203.0.113.0 netmask 255.255.255.0 {',
  '  range 203.0.113.100 203.0.113.110;',
  '}',
  'subnet 192.168.1.0 netmask 255.255.255.0 {',
  '  range 192.168.1.100 192.168.1.150;',
  '  option routers 192.168.1.1;',
  '  option domain-name-servers 203.0.113.9;',
  '}',
].join('\\n');

interface Lab { fw: Cli; pc: LinuxPC; srv: LinuxServer; wanClient: LinuxPC }

async function buildLab(relay: readonly string[]): Promise<Lab> {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'dhcp', 0, 0);
  const wanClient = new LinuxPC('linux-pc', 'wan-client', 0, 0);
  const wanSwitch = createDevice('switch-generic', 0, 0) as unknown as Cli & { powerOn(): void };
  for (const host of [pc, srv, wanClient]) host.powerOn();
  wanSwitch.powerOn();
  const wanPorts = wanSwitch.getPortNames();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, wanSwitch.getPort(wanPorts[0]) as never);
  new Cable('srv').connect(srv.getPort('eth0') as never, wanSwitch.getPort(wanPorts[1]) as never);
  new Cable('wc').connect(wanClient.getPort('eth0') as never, wanSwitch.getPort(wanPorts[2]) as never);
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', ...relay, 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next',
    'end',
  ]);
  await taper(srv as unknown as Cli, [
    'ip link set eth0 up', 'ip addr add 203.0.113.9/24 dev eth0', 'ip route add default via 203.0.113.1',
    `printf '${DHCPD_CONF}\\n' > /etc/dhcp/dhcpd.conf`,
    'systemctl start isc-dhcp-server',
  ]);
  await taper(pc as unknown as Cli, ['ip link set eth0 up']);
  await taper(wanClient as unknown as Cli, ['ip link set eth0 up']);
  return { fw, pc, srv, wanClient };
}

const RELAY = ['set dhcp-relay-service enable', 'set dhcp-relay-ip "203.0.113.9"'];

describe('FortiGate DHCP relay', () => {
  it('the server serves its own segment', async () => {
    const { wanClient } = await buildLab([]);
    await wanClient.executeCommand('dhclient eth0');
    expect(await wanClient.executeCommand('ip -4 addr show eth0')).toMatch(/inet 203\.0\.113\.1(0\d|10)\/24/);
  });

  it('the relay attributes are stored and rendered', async () => {
    const { fw } = await buildLab(RELAY);
    const shown = await fw.executeCommand('show system interface port1');
    expect(shown).toContain('set dhcp-relay-service enable');
    expect(shown).toContain('set dhcp-relay-ip "203.0.113.9"');
  });

  it('a LAN client leases from the server behind the firewall', async () => {
    const { pc } = await buildLab(RELAY);
    await pc.executeCommand('dhclient eth0');
    expect(await pc.executeCommand('ip -4 addr show eth0')).toMatch(/inet 192\.168\.1\.1([0-4]\d|50)\/24/);
    expect(await pc.executeCommand('ip route show default')).toMatch(/^default via 192\.168\.1\.1 /m);
  });

  it('the server records the lease of the relayed subnet', async () => {
    const { pc, srv } = await buildLab(RELAY);
    await pc.executeCommand('dhclient eth0');
    expect(await srv.executeCommand('cat /var/lib/dhcp/dhcpd.leases')).toMatch(/^lease 192\.168\.1\.1([0-4]\d|50) \{/m);
  });

  it('without the relay the LAN client gets nothing', async () => {
    const { pc } = await buildLab([]);
    await pc.executeCommand('dhclient eth0');
    expect(await pc.executeCommand('ip -4 addr show eth0')).not.toMatch(/inet 192\.168\.1\./);
  });

  it('an ipsec relay does not relay regular broadcasts', async () => {
    const { pc } = await buildLab([...RELAY, 'set dhcp-relay-type ipsec']);
    await pc.executeCommand('dhclient eth0');
    expect(await pc.executeCommand('ip -4 addr show eth0')).not.toMatch(/inet 192\.168\.1\./);
  });
});

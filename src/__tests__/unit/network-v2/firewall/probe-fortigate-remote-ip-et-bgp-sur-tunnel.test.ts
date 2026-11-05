/*
 * Probe: `set remote-ip` on an interface (FortiOS CLI Reference 7.4.12, system interface) installs the connected
 * host route towards the far end of a point-to-point tunnel, so two units can address each other on /32 tunnel
 * addresses and run BGP over the IPsec interface (TCP 179 crossing the tunnel as ESP frames).
 * Measured before: 'unknown attribute "remote-ip"', and no way to give a tunnel interface a peer address.
 * The firewall's own TCP stack also resolved egress only on directly connected physical ports: it now follows the
 * routing table and tunnel interfaces (BGP over the tunnel, `execute telnet` to a host behind it).
 * Discriminated with git stash on src/network: 5 of 6 fall before the fix ; the witness (the tunnel comes
 * up on request) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab(withRemote = true) {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const bench = new LabWorkbench();
  const a = bench.place('firewall-fortinet', 'A', 0, 0);
  const b = bench.place('firewall-fortinet', 'B', 0, 0);
  bench.connect(a, 'wan1', b, 'wan1');
  const side = (wan: string, peer: string, tunnelIp: string, remote: string, asn: number, peerAsn: number, id: string) => [
    'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`, 'next', 'end',
    'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2', `set remote-gw ${peer}`,
    'set psksecret sekret123', 'set proposal aes256-sha256', 'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "t"', 'set phase1name "t"', 'set proposal aes256-sha256',
    'set src-subnet 0.0.0.0 0.0.0.0', 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
    'config system interface', 'edit "t"', `set ip ${tunnelIp} 255.255.255.255`,
    ...(withRemote ? [`set remote-ip ${remote} 255.255.255.255`] : []), 'next', 'end',
    'config router bgp', `set as ${asn}`, `set router-id ${id}`, 'config neighbor', `edit ${remote}`, `set remote-as ${peerAsn}`, 'next', 'end', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "t"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
  ];
  const typedA = await bench.shell(a, ...side('203.0.113.1', '203.0.113.2', '172.31.0.1', '172.31.0.2', 65001, 65002, '1.1.1.1'));
  const typedB = await bench.shell(b, ...side('203.0.113.2', '203.0.113.1', '172.31.0.2', '172.31.0.1', 65002, 65001, '2.2.2.2'));
  clock.advance(240_000);
  return { a, b, typed: typedA + typedB, clock };
}

describe('remote-ip on a tunnel interface', () => {
  it('witness: the IPsec tunnel itself comes up when traffic is sent', async () => {
    const { a } = await lab(false);
    await a.executeCommand('diagnose vpn tunnel up t');
    expect(await a.executeCommand('get vpn ipsec tunnel summary')).toMatch(/selectors\(total,up\): 1\/1/);
  });

  it('accepts the attribute', async () => {
    const { typed } = await lab();
    expect(typed).not.toMatch(/unknown attribute/);
  });

  it('installs a connected host route to the remote address on the tunnel', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('get router info routing-table connected')).toMatch(/172\.31\.0\.2\/32 is directly connected, t/);
  });

  it('the running configuration reproduces it', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('show system interface t')).toContain('set remote-ip 172.31.0.2 255.255.255.255');
  });

  it('BGP between the two tunnel addresses establishes over the IPsec interface', async () => {
    const { a, clock } = await lab();
    await a.executeCommand('diagnose vpn tunnel up t');
    clock.advance(600_000);
    const summary = await a.executeCommand('get router info bgp summary');
    expect(summary).toMatch(/172\.31\.0\.2\s+4\s+65002\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\S+\s+\d+\s*$/m);
  });

  it('traffic the FortiGate originates over TCP follows a route to a host behind the tunnel', async () => {
    const clock = new VirtualTimeScheduler();
    __setDefaultScheduler(clock);
    const bench = new LabWorkbench();
    const a = bench.place('firewall-fortinet', 'A', 0, 0);
    const b = bench.place('firewall-fortinet', 'B', 0, 0);
    const srv = bench.place('linux-server', 'SRV', 0, 0);
    bench.connect(a, 'wan1', b, 'wan1');
    bench.connect(b, 'port1', srv, 'eth0');
    const side = (wan: string, peer: string, local: string, lan: string, tunnelIp: string, remote: string) => [
      'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`, 'next', 'edit port1', 'set mode static', `set ip ${lan} 255.255.255.0`, 'next', 'end',
      'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2', `set remote-gw ${peer}`,
      'set psksecret sekret123', 'set proposal aes256-sha256', 'next', 'end',
      'config vpn ipsec phase2-interface', 'edit "t"', 'set phase1name "t"', 'set proposal aes256-sha256',
      `set src-subnet ${local}`, 'set dst-subnet 0.0.0.0 0.0.0.0', 'next', 'end',
      'config system interface', 'edit "t"', `set ip ${tunnelIp} 255.255.255.255`, `set remote-ip ${remote} 255.255.255.255`, 'next', 'end',
      'config firewall policy', 'edit 1', 'set srcintf "t"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
    ];
    await bench.shell(a, ...side('203.0.113.1', '203.0.113.2', '0.0.0.0 0.0.0.0', '10.0.0.1', '172.31.0.1', '172.31.0.2'),
      'config router static', 'edit 1', 'set dst 10.1.0.0 255.255.255.0', 'set device "t"', 'next', 'end');
    await bench.shell(b, ...side('203.0.113.2', '203.0.113.1', '10.1.0.0 255.255.255.0', '10.1.0.1', '172.31.0.2', '172.31.0.1'),
      'config router static', 'edit 1', 'set dst 10.0.0.0 255.255.255.0', 'set device "t"', 'next', 'end');
    await bench.shell(srv, 'ip addr add 10.1.0.50/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.1.0.1');
    await a.executeCommand('diagnose vpn tunnel up t');
    const out = await a.executeCommand('execute telnet 10.1.0.50 22');
    expect(out).toContain('Connected to 10.1.0.50.');
  });
});
